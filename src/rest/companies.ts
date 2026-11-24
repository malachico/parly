import type { Router } from 'express';
import type { HubService } from '../hub/hubService.js';
import { agentOf, requireAgent } from '../lib/auth.js';
import { HubError } from '../lib/errors.js';
import { BILLING, CREDIT_MICROS, TEAM_MIN_SEATS, limitsOf, type BillingRecord } from '../lib/plans.js';
import { isCompanyOwner } from '../billing/company.js';
import { FieldValue } from '../db/types.js';
import type { AgentRecord } from '../registry/types.js';
import { json, str } from './helpers.js';

/** Pending company invites, doc id `${companyId}:${email}`. Not `invites`: sign-in consumes every row there. */
export const COMPANY_INVITES = 'companyInvites';

interface CompanyInvite {
  companyId: string;
  email: string;
  invitedBy: string;
  createdAt: number;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Seats a company may fill (owners, members and pending invites): Team's paid seats, Enterprise's (unlimited unless set), else none. */
function seatLimit(rec: BillingRecord | undefined): number {
  const plan = limitsOf(rec, 0).plan;
  if (plan === 'team') return Math.max(TEAM_MIN_SEATS, rec?.seats ?? 0);
  if (plan === 'enterprise') return rec?.seats ?? Infinity;
  return 0;
}

/** Seats taken: each owner and member once (an owner linked as a member too counts once), plus pending invites. */
function seatsUsed(rec: BillingRecord | undefined, memberIds: string[], pending: number): number {
  return new Set([...(rec?.owners ?? []), ...memberIds]).size + pending;
}

/**
 * Companies (a workspace-keyed billing record with `name` and `owners`): owners invite people by email, an invitee accepts
 * (which sets their billingAccountId, moving them from any other company), and anyone leaves or is removed.
 * ponytail: invites don't expire; owners revoke them. Add an expiresAt (TTL) if stale invites hold seats in practice.
 */
export function companiesRoutes(router: Router, hub: HubService): void {
  const db = hub.registry.db;
  const billing = db.collection(BILLING);
  const agents = db.collection('agents');
  const invites = db.collection(COMPANY_INVITES);

  const companyName = async (id: string, rec?: BillingRecord) => rec?.name ?? (await hub.registry.workspaceDoc(id))?.name ?? id;

  /** The company `id` and whether `me` owns it; 404 when it isn't one. */
  async function company(id: string, me: AgentRecord) {
    const rec = (await billing.doc(id).get()).data() as BillingRecord | undefined;
    const ws = await hub.registry.workspaceDoc(id);
    if (!rec && !ws) throw new HubError('not_found', 'No such company');
    return { rec, owner: isCompanyOwner(rec, ws, me.id) };
  }

  /** An owner's view of company `id`: plan, seats, members and their spend, pending invites, budget and pool. */
  async function ownerView(id: string, rec: BillingRecord) {
    const [limits, { spentMicros, capMicros, budgetMicros }, rows, blockedBy, memberSnap, inviteSnap] = await Promise.all([
      hub.llm.limits(id),
      hub.llm.balance(id),
      hub.llm.agentSpend(id),
      hub.llm.blockedBy(id),
      agents.where('billingAccountId', '==', id).get(),
      invites.where('companyId', '==', id).get(),
    ]);
    // Spend is per agent; a person's is their own plus their agents'.
    const spenders = await hub.registry.workspaceStore.getAgentsByIds([...new Set(rows.map((r) => r.agentId))]);
    const personOf = new Map(spenders.map((a) => [a.id, a.ownerId ?? a.id]));
    const byPerson = new Map<string, number>();
    for (const r of rows) {
      const p = personOf.get(r.agentId) ?? r.agentId;
      byPerson.set(p, (byPerson.get(p) ?? 0) + r.micros);
    }
    const members = memberSnap.docs.map((d) => d.data() as AgentRecord);
    // Owners hold a seat and spend from the pool even unlinked, so they're listed too, once each.
    const linked = new Set(members.map((a) => a.id));
    members.push(...(await hub.registry.workspaceStore.getAgentsByIds((rec.owners ?? []).filter((o) => !linked.has(o)))));
    const pending = inviteSnap.docs.map((d) => d.data() as CompanyInvite);
    const max = seatLimit(rec);
    return {
      id,
      name: await companyName(id, rec),
      plan: limits.plan,
      seats: { used: seatsUsed(rec, memberSnap.docs.map((d) => d.id), pending.length), max: max === Infinity ? null : max },
      managed: !!rec.paddleSubscriptionId,
      monthlyUsd: limits.monthlyMicros / 1e6,
      extraUsd: limits.extraMicros / 1e6,
      leftUsd: Math.max(0, capMicros - spentMicros) / 1e6,
      budgetCredits: budgetMicros === undefined ? null : budgetMicros / CREDIT_MICROS,
      spentCredits: spentMicros / CREDIT_MICROS,
      ...(blockedBy ? { blockedBy } : {}),
      members: members
        .map((a) => ({ id: a.id, name: a.name, email: a.email, owner: !!rec.owners?.includes(a.id), spentUsd: (byPerson.get(a.id) ?? 0) / 1e6 }))
        .sort((a, b) => b.spentUsd - a.spentUsd),
      invites: pending.map((i) => ({ email: i.email, createdAt: i.createdAt })).sort((a, b) => a.createdAt - b.createdAt),
    };
  }

  /**
   * `member`: the company my billingAccountId links me to (its name, owners, whether it pays; where I leave), unless I own it.
   * `owned`: the full view of each company I own. An owner of one company can be a member of another.
   */
  router.get(
    '/me/company',
    requireAgent,
    json(async (req) => {
      const me = agentOf(req)!;
      const [ownedSnap, mine] = await Promise.all([billing.where('owners', 'array-contains', me.id).get(), agents.doc(me.id).get()]);
      const id = (mine.data() as AgentRecord | undefined)?.billingAccountId;
      let member = null;
      if (id && !ownedSnap.docs.some((d) => d.id === id)) {
        const rec = (await billing.doc(id).get()).data() as BillingRecord | undefined;
        const owners = await hub.registry.workspaceStore.getAgentsByIds(rec?.owners ?? []);
        const plan = limitsOf(rec, 0).plan;
        member = { id, name: await companyName(id, rec), plan, active: plan === 'team' || plan === 'enterprise', owners: owners.map((a) => a.name) };
      }
      return { member, owned: await Promise.all(ownedSnap.docs.map((d) => ownerView(d.id, d.data() as BillingRecord))) };
    }),
  );

  /** Owner only: invite `{email}`. A pending invite holds a seat: owners, members and invites stay within the plan's seats. */
  router.post(
    '/companies/:id/invites',
    requireAgent,
    json(async (req, res) => {
      const me = agentOf(req)!;
      const id = String(req.params.id);
      const { rec, owner } = await company(id, me);
      if (!owner) throw new HubError('forbidden', "Only the company's owners invite people");
      const email = str((req.body ?? {}).email)?.trim().toLowerCase();
      if (!email || !EMAIL.test(email)) throw new HubError('invalid', 'A valid email is required');
      hub.registry.inviteLimiter?.hit(me.id); // re-sends count too: each one mails
      await db.runTransaction(async (tx) => {
        const fresh = (await tx.get(billing.doc(id))).data() as BillingRecord | undefined;
        const max = seatLimit(fresh);
        if (!max) throw new HubError('invalid', 'Inviting people needs an active Team or Enterprise plan');
        const memberDocs = (await tx.get(agents.where('billingAccountId', '==', id))).docs;
        if (memberDocs.some((d) => (d.data() as AgentRecord).email === email)) throw new HubError('conflict', `${email} is already a member`);
        const pending = (await tx.get(invites.where('companyId', '==', id))).docs.filter((d) => d.id !== `${id}:${email}`).length;
        if (seatsUsed(fresh, memberDocs.map((d) => d.id), pending) + 1 > max) throw new HubError('plan_limit', `All ${max} seats are taken. Add seats, or revoke an invite or remove a member first.`);
        tx.set(invites.doc(`${id}:${email}`), { companyId: id, email, invitedBy: me.id, createdAt: Date.now() } satisfies CompanyInvite);
      });
      hub.registry
        .mailInvite?.({ email, workspaceName: await companyName(id, rec), invitedByName: me.name, company: true })
        .catch((err) => console.error('company invite email failed', err));
      res.status(201);
      return { companyId: id, email };
    }),
  );

  /** My pending company invites (by my verified email). */
  router.get(
    '/me/company/invites',
    requireAgent,
    json(async (req) => {
      const me = agentOf(req)!;
      if (!me.email) return [];
      const pending = (await invites.where('email', '==', me.email.toLowerCase()).get()).docs.map((d) => d.data() as CompanyInvite);
      const inviters = new Map((await hub.registry.workspaceStore.getAgentsByIds([...new Set(pending.map((i) => i.invitedBy))])).map((a) => [a.id, a.name]));
      return Promise.all(
        pending.map(async (i) => ({
          companyId: i.companyId,
          companyName: await companyName(i.companyId, (await billing.doc(i.companyId).get()).data() as BillingRecord | undefined),
          invitedByName: inviters.get(i.invitedBy) ?? null,
          createdAt: i.createdAt,
        })),
      );
    }),
  );

  /**
   * Accept my invite (sent to my verified email): sets my billingAccountId, moving my membership from any other company.
   * Companies I own stay mine (and keep my seat there). Idempotent.
   * Seats are re-checked in the transaction, so two accepts for the last seat can't both win.
   */
  router.post(
    '/companies/:id/accept',
    requireAgent,
    json(async (req) => {
      const me = agentOf(req)!;
      const id = String(req.params.id);
      if (!me.email) throw new HubError('forbidden', 'Sign in with Google to accept a company invite');
      const email = me.email.toLowerCase();
      await db.runTransaction(async (tx) => {
        const fresh = (await tx.get(agents.doc(me.id))).data() as AgentRecord | undefined;
        if (fresh?.billingAccountId === id) return;
        const invite = invites.doc(`${id}:${email}`);
        if (!(await tx.get(invite)).exists) throw new HubError('not_found', 'No invite to this company for your email');
        const target = (await tx.get(billing.doc(id))).data() as BillingRecord | undefined;
        const members = (await tx.get(agents.where('billingAccountId', '==', id))).docs.map((d) => d.id);
        // My invite becomes my seat (one I already hold if I own it); other pending invites only reserve theirs.
        if (seatsUsed(target, [...members, me.id], 0) > seatLimit(target)) throw new HubError('plan_limit', 'This company has no free seat. Ask its owner to add one.');
        tx.update(agents.doc(me.id), { billingAccountId: id });
        tx.delete(invite);
      });
      return { companyId: id };
    }),
  );

  /** Revoke (an owner) or decline (the invitee) a pending invite. */
  router.delete(
    '/companies/:id/invites/:email',
    requireAgent,
    json(async (req) => {
      const me = agentOf(req)!;
      const id = String(req.params.id);
      const email = String(req.params.email).toLowerCase();
      if (email !== me.email && !(await company(id, me)).owner) throw new HubError('forbidden', "Only the company's owners or the invitee remove an invite");
      await invites.doc(`${id}:${email}`).delete();
      return { companyId: id, email };
    }),
  );

  /** An owner removes a member, or a member (or co-owner) leaves. A sole owner can't leave. */
  router.delete(
    '/companies/:id/members/:personId',
    requireAgent,
    json(async (req) => {
      const me = agentOf(req)!;
      const id = String(req.params.id);
      const personId = String(req.params.personId);
      const self = personId === me.id;
      if (!self && !(await company(id, me)).owner) throw new HubError('forbidden', "Only the company's owners remove members");
      await db.runTransaction(async (tx) => {
        const target = (await tx.get(agents.doc(personId))).data() as AgentRecord | undefined;
        const rec = (await tx.get(billing.doc(id))).data() as BillingRecord | undefined;
        const owns = self && !!rec?.owners?.includes(me.id);
        if (owns && rec!.owners!.length === 1) throw new HubError('conflict', "You're this company's only owner, so you can't leave it");
        if (target?.billingAccountId !== id && !owns) throw new HubError('not_found', 'Not a member of this company');
        if (owns) tx.update(billing.doc(id), { owners: FieldValue.arrayRemove(me.id) });
        if (target?.billingAccountId === id) tx.update(agents.doc(personId), { billingAccountId: FieldValue.delete() });
      });
      return { companyId: id, personId };
    }),
  );
}
