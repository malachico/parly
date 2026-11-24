import { randomUUID } from 'node:crypto';
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
  /** Claimed by an accept in progress (ms, and who): revoking is refused until it finishes or the claim expires. */
  acceptingAt?: number;
  acceptingBy?: string;
}

/** A removal or accept claim older than this is abandoned (the hub died mid-way) and can be retaken. */
const REMOVAL_CLAIM_MS = 60_000;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Seats a company may fill (owners, members and pending invites): Team's paid seats, else none. */
function seatLimit(rec: BillingRecord | undefined): number {
  const plan = limitsOf(rec, 0).plan;
  if (plan === 'team') return Math.max(TEAM_MIN_SEATS, rec?.seats ?? 0);
  return 0;
}

/** Seats taken: each owner and member once (an owner linked as a member too counts once), plus pending invites. */
function seatsUsed(rec: BillingRecord | undefined, memberIds: string[], pending: number): number {
  return new Set([...(rec?.owners ?? []), ...memberIds]).size + pending;
}

/**
 * Lowers a Team's subscription to who is left (owners and members, `gone` not counted as a member, nor as an owner when
 * `ownerGone`, plus pending invites; at least the minimum). Counted from the records, not from `seats`, so a change whose
 * local write failed after Paddle took it is corrected by the next one. Returns the new quantity, if Paddle was called.
 */
async function lowerSeatsOf(hub: HubService, id: string, gone?: string, ownerGone = false): Promise<number | undefined> {
  const db = hub.registry.db;
  const rec = (await db.collection(BILLING).doc(id).get()).data() as BillingRecord | undefined;
  const members = (await db.collection('agents').where('billingAccountId', '==', id).get()).docs.map((d) => d.id).filter((m) => m !== gone);
  const pending = (await db.collection(COMPANY_INVITES).where('companyId', '==', id).get()).docs.length;
  const owners = (rec?.owners ?? []).filter((o) => !ownerGone || o !== gone);
  return hub.billing.lowerSeats(id, Math.max(TEAM_MIN_SEATS, seatsUsed({ ...rec, owners } as BillingRecord, members, pending)));
}

/**
 * After a change is written, count again until Paddle and `seats` match who is left: a removal on another instance that
 * counted before ours landed leaves them one high, and whichever of the two finishes last sees both. `seatsSyncPending`
 * is set first (with a `seatsSyncToken` per recount) and cleared only once they match and no other recount started or
 * failed since, so a failed round (Paddle down) is retried by retryBilling. Errors only logged.
 */
// ponytail: 5 rounds, then seatsSyncPending leaves the rest to the sweep; a company-doc lease if removals ever outrun that.
async function recountOf(hub: HubService, id: string) {
  const db = hub.registry.db;
  const doc = db.collection(BILLING).doc(id);
  const token = randomUUID();
  try {
    await doc.update({ seatsSyncPending: true, seatsSyncToken: token }).catch((err) => console.error(`company ${id}: seatsSyncPending not set`, err));
    for (let i = 0; i < 5; i++) {
      const seats = await lowerSeatsOf(hub, id);
      if (seats === undefined) {
        // Only if no recount started or failed since ours: a stale clear would drop a newer failure's flag.
        return void (await db.runTransaction(async (tx) => {
          if ((await tx.get(doc)).data()?.seatsSyncToken === token) tx.update(doc, { seatsSyncPending: FieldValue.delete(), seatsSyncToken: FieldValue.delete() });
        }));
      }
      await doc.update({ seats });
    }
  } catch (err) {
    console.error(`company ${id}: seats not recounted`, err);
    // A fresh token, so no recount that started earlier can clear it.
    await doc.update({ seatsSyncPending: true, seatsSyncToken: randomUUID() }).catch(() => {});
  }
}

/** Whether a Team pays for this person now. */
async function coveredOf(hub: HubService, personId: string) {
  const db = hub.registry.db;
  const payer = ((await db.collection('agents').doc(personId).get()).data() as AgentRecord | undefined)?.billingAccountId;
  return !!payer && limitsOf((await db.collection(BILLING).doc(payer).get()).data() as BillingRecord | undefined, 0).plan === 'team';
}

/** Whether this person holds a live accept claim on some invite. */
async function acceptingOf(hub: HubService, personId: string) {
  const now = Date.now();
  const claims = (await hub.registry.db.collection(COMPANY_INVITES).where('acceptingBy', '==', personId).get()).docs;
  return claims.some((i) => now - ((i.data() as CompanyInvite).acceptingAt ?? 0) < REMOVAL_CLAIM_MS);
}

/** Whether Pro should be cancelled now: a Team covers the person, or they are mid-accept. */
async function heldOf(hub: HubService, personId: string) {
  return (await coveredOf(hub, personId)) || (await acceptingOf(hub, personId));
}

/**
 * Undoes a Pro cancel made for a join that failed; `proRestorePending` keeps it owed until done (retryBilling retries).
 * The PATCH may land after a new accept's cancel, so once it's back we look again: if Pro should be cancelled now, it is,
 * again (`proCancelPending` keeps that owed if Paddle refuses).
 */
async function restorePro(hub: HubService, personId: string) {
  const doc = hub.registry.db.collection(BILLING).doc(personId);
  try {
    await doc.update({ proRestorePending: true }).catch((err) => console.error(`${personId}: proRestorePending not set`, err));
    await hub.billing.resumePro(personId);
    if (await heldOf(hub, personId)) await recancelPro(hub, personId);
    else await doc.update({ proRestorePending: FieldValue.delete() });
  } catch (err) {
    console.error(`${personId}: Pro cancel not undone`, err);
  }
}

/**
 * Cancels Pro again after an undo that raced an accept; `proCancelPending` keeps it owed until Paddle takes it. If that
 * accept failed meanwhile (its undo may have landed before our cancel), the undo is owed again for the sweep.
 */
async function recancelPro(hub: HubService, personId: string) {
  const doc = hub.registry.db.collection(BILLING).doc(personId);
  await doc.update({ proCancelPending: true, proRestorePending: FieldValue.delete() }).catch((err) => console.error(`${personId}: proCancelPending not set`, err));
  try {
    await hub.billing.cancelAtPeriodEnd(personId, true);
    const held = await heldOf(hub, personId);
    await doc.update({ proCancelPending: FieldValue.delete(), ...(held ? {} : { proRestorePending: true }) });
  } catch (err) {
    console.error(`${personId}: Pro not cancelled again`, err);
  }
}

/**
 * The /tick and per-instance sweep: recounts companies whose seats didn't converge, and undoes Pro cancels still owed
 * (dropped instead once a Team covers the person), and re-makes Pro cancels an undo raced (dropped once
 * nothing covers the person). Never throws; returns how many it looked at.
 */
export async function retryBilling(hub: HubService): Promise<number> {
  const db = hub.registry.db;
  const billing = db.collection(BILLING);
  try {
    const pending = (f: string) => billing.where(f, '==', true).get();
    const [seats, pro, cancel] = await Promise.all([pending('seatsSyncPending'), pending('proRestorePending'), pending('proCancelPending')]);
    for (const d of seats.docs) await recountOf(hub, d.id);
    for (const d of pro.docs) {
      if (await coveredOf(hub, d.id)) {
        await billing.doc(d.id).update({ proRestorePending: FieldValue.delete() });
        continue;
      }
      // Still owed and not mid-accept (an accept clears the flag and cancels anew); one starting during it, restorePro catches.
      const owed = await db.runTransaction(async (tx) => {
        if (!((await tx.get(billing.doc(d.id))).data() as BillingRecord | undefined)?.proRestorePending) return false;
        const now = Date.now();
        const claims = (await tx.get(db.collection(COMPANY_INVITES).where('acceptingBy', '==', d.id))).docs;
        return !claims.some((i) => now - ((i.data() as CompanyInvite).acceptingAt ?? 0) < REMOVAL_CLAIM_MS);
      });
      if (owed) await restorePro(hub, d.id);
    }
    for (const d of cancel.docs) {
      if (await coveredOf(hub, d.id)) await recancelPro(hub, d.id);
      else await billing.doc(d.id).update({ proCancelPending: FieldValue.delete() });
    }
    return seats.docs.length + pro.docs.length + cancel.docs.length;
  } catch (err) {
    console.error('billing retry failed', err);
    return 0;
  }
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

  const active = (rec: BillingRecord | undefined) => limitsOf(rec, 0).plan === 'team';
  /** The company I own (one per owner), if any. */
  const ownedBy = async (personId: string) => (await billing.where('owners', 'array-contains', personId).limit(1).get()).docs[0]?.id;
  /** An unpaid draft (an abandoned Team checkout): never subscribed, no balance, `me` its only owner and nobody else linked. */
  const isDraft = (rec: BillingRecord | undefined, me: string, linked: string[]) =>
    !!rec && !active(rec) && !rec.paddleSubscriptionId && !rec.extraMicros && rec.owners?.length === 1 && rec.owners[0] === me && linked.every((m) => m === me);

  /** One seat change at a time per company in this instance; recount() covers changes racing on another instance. */
  const queues = new Map<string, Promise<unknown>>();
  const serial = <T>(id: string, fn: () => Promise<T>): Promise<T> => {
    const p = (queues.get(id) ?? Promise.resolve()).catch(() => {}).then(fn);
    queues.set(id, p);
    p.catch(() => {}).finally(() => queues.get(id) === p && queues.delete(id));
    return p;
  };
  const lowerSeats = (id: string, gone?: string, ownerGone = false) => lowerSeatsOf(hub, id, gone, ownerGone);
  const recount = (id: string) => recountOf(hub, id);

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
    // ponytail: model spend (agentUsage) only, metered tools aren't per agent. Rows are per payer, so only the company's part shows; a legacy (pre-split) row keeps its last payer's whole month.
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
        member = { id, name: await companyName(id, rec), plan, active: plan === 'team', owners: owners.map((a) => a.name) };
      }
      return { member, owned: await Promise.all(ownedSnap.docs.map((d) => ownerView(d.id, d.data() as BillingRecord))) };
    }),
  );

  /** Start a company `{name}` (named at Team checkout, which then pays for it). One per person: my own if I have one. */
  router.post(
    '/companies',
    requireAgent,
    json(async (req, res) => {
      const me = agentOf(req)!;
      const name = str((req.body ?? {}).name)?.trim();
      if (!name) throw new HubError('invalid', 'A company name is required');
      const mine = await ownedBy(me.id);
      if (mine) return { id: mine, name: await companyName(mine, (await billing.doc(mine).get()).data() as BillingRecord | undefined) };
      const linked = (me as AgentRecord).billingAccountId ?? ((await agents.doc(me.id).get()).data() as AgentRecord | undefined)?.billingAccountId;
      if (linked && active((await billing.doc(linked).get()).data() as BillingRecord | undefined)) {
        throw new HubError('conflict', 'You already belong to a company. Leave it first.');
      }
      // One per person, atomically: the unique index createdBy_unique (db/mongo.ts) turns a concurrent second create into a 409.
      const id = randomUUID();
      await billing
        .doc(id)
        .create({ ownerId: id, kind: 'company', createdBy: me.id, name, owners: [me.id], plan: 'free', updatedAt: new Date().toISOString() } satisfies BillingRecord)
        .catch((err) => {
          throw (err as { code?: number }).code === 6 ? new HubError('conflict', 'You already have a company') : err;
        });
      res.status(201);
      return { id, name };
    }),
  );

  /** A company: its owners see everything (ownerView, with the budget); a member sees its name, plan and owners. */
  router.get(
    '/companies/:id',
    requireAgent,
    json(async (req) => {
      const me = agentOf(req)!;
      const id = String(req.params.id);
      const { rec, owner } = await company(id, me);
      if (owner) return ownerView(id, rec ?? { ownerId: id, plan: 'free' });
      if (((await agents.doc(me.id).get()).data() as AgentRecord | undefined)?.billingAccountId !== id) throw new HubError('forbidden', "Only the company's people see it");
      const owners = await hub.registry.workspaceStore.getAgentsByIds(rec?.owners ?? []);
      return { id, name: await companyName(id, rec), plan: limitsOf(rec, 0).plan, owners: owners.map((a) => a.name) };
    }),
  );

  /** Owner only: the company's monthly budget `{credits}` (null removes it). */
  router.put(
    '/companies/:id/budget',
    requireAgent,
    json(async (req) => {
      const id = String(req.params.id);
      if (!(await company(id, agentOf(req)!)).owner) throw new HubError('forbidden', "Only the company's owners set its budget");
      await hub.billing.setBudget(id, (req.body ?? {}).credits);
      const { budgetMicros } = await hub.llm.balance(id);
      return { companyId: id, budgetCredits: budgetMicros === undefined ? null : budgetMicros / CREDIT_MICROS };
    }),
  );

  /** Owner only: Paddle's portal for the company's subscription (seats, cards, invoices). */
  router.post(
    '/companies/:id/billing/portal',
    requireAgent,
    json(async (req) => {
      const id = String(req.params.id);
      if (!(await company(id, agentOf(req)!)).owner) throw new HubError('forbidden', "Only the company's owners manage its billing");
      return { url: await hub.billing.portalUrl(id) };
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
        const old = (await tx.get(invites.doc(`${id}:${email}`))).data() as CompanyInvite | undefined;
        if (old?.acceptingAt && Date.now() - old.acceptingAt < REMOVAL_CLAIM_MS) throw new HubError('conflict', 'This invite is being accepted right now');
        const max = seatLimit(fresh);
        if (!max) throw new HubError('invalid', 'Inviting people needs an active Team plan');
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
   * Accept my invite (sent to my verified email): sets my billingAccountId, moving my membership from any other company
   * (whose Team then drops the seat, best effort: the next change there recounts).
   * One company per person: an owner of another company can't join, unless it's an unpaid draft (deleted on joining).
   * My Pro, if any, is cancelled at its period's end first: if Paddle fails, 502 and I don't join. Idempotent.
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
      const invite = invites.doc(`${id}:${email}`);
      // Checked and the invite claimed (so it can't be revoked meanwhile), then Pro cancelled, then checked again and written.
      // A failure between the two (seats filled by an earlier claim's join, or ownership changed) undoes the Pro cancel.
      let from: string | undefined;
      const join = (write: boolean) =>
        db.runTransaction(async (tx) => {
          const now = Date.now();
          const fresh = (await tx.get(agents.doc(me.id))).data() as AgentRecord | undefined;
          if (fresh?.billingAccountId === id) return false;
          const drafts: string[] = [];
          for (const d of (await tx.get(billing.where('owners', 'array-contains', me.id))).docs) {
            if (d.id === id) continue;
            const linked = (await tx.get(agents.where('billingAccountId', '==', d.id))).docs.map((a) => a.id);
            if (!isDraft(d.data() as BillingRecord, me.id, linked)) throw new HubError('conflict', 'You own another company, so you can’t join this one');
            drafts.push(d.id);
          }
          const inv = (await tx.get(invite)).data() as CompanyInvite | undefined;
          if (!inv) throw new HubError('not_found', 'No invite to this company for your email');
          if (!write && inv.acceptingBy !== me.id && inv.acceptingAt && now - inv.acceptingAt < REMOVAL_CLAIM_MS) throw new HubError('conflict', 'This invite is already being accepted');
          const target = (await tx.get(billing.doc(id))).data() as BillingRecord | undefined;
          const members = (await tx.get(agents.where('billingAccountId', '==', id))).docs.map((d) => d.id);
          // My invite becomes my seat (one I already hold if I own it); other pending invites only reserve theirs.
          if (seatsUsed(target, [...members, me.id], 0) > seatLimit(target)) throw new HubError('plan_limit', 'This company has no free seat. Ask its owner to add one.');
          if (!write) {
            tx.update(invite, { acceptingAt: now, acceptingBy: me.id });
            return true;
          }
          for (const d of drafts) tx.delete(billing.doc(d));
          tx.update(agents.doc(me.id), { billingAccountId: id });
          tx.delete(invite);
          from = drafts.includes(fresh?.billingAccountId ?? '') ? undefined : fresh?.billingAccountId;
          return true;
        });
      // Team covers me from now on; Paddle's update then marks my Pro cancelled at period end.
      if (await join(false)) {
        let cancelled = false;
        // A stale undo owed from an earlier failed join must not revert the cancel made now.
        await billing.doc(me.id).update({ proRestorePending: FieldValue.delete() }).catch(() => {});
        try {
          cancelled = await hub.billing.cancelAtPeriodEnd(me.id);
          await join(true);
        } catch (err) {
          // Not joined: my Pro goes on (only a cancel made here is undone). The claim goes first, or the undo would see it and re-cancel.
          await invite.update({ acceptingAt: FieldValue.delete(), acceptingBy: FieldValue.delete() }).catch(() => {});
          if (cancelled) await restorePro(hub, me.id);
          throw err;
        }
        const left = from;
        if (left) await serial(left, () => recount(left));
      }
      return { companyId: id };
    }),
  );

  /** Revoke (an owner) or decline (the invitee) a pending invite. 409 while it is being accepted. */
  router.delete(
    '/companies/:id/invites/:email',
    requireAgent,
    json(async (req) => {
      const me = agentOf(req)!;
      const id = String(req.params.id);
      const email = String(req.params.email).toLowerCase();
      if (email !== me.email && !(await company(id, me)).owner) throw new HubError('forbidden', "Only the company's owners or the invitee remove an invite");
      await db.runTransaction(async (tx) => {
        const ref = invites.doc(`${id}:${email}`);
        const inv = (await tx.get(ref)).data() as CompanyInvite | undefined;
        if (inv?.acceptingAt && Date.now() - inv.acceptingAt < REMOVAL_CLAIM_MS) throw new HubError('conflict', 'This invite is being accepted right now');
        if (inv) tx.delete(ref);
      });
      return { companyId: id, email };
    }),
  );

  /**
   * An owner removes a member, or a member (or co-owner) leaves. A sole owner can't leave, unless the company is an unpaid
   * draft (it is deleted). Either way the Team subscription first drops to who is left (owners, members, pending invites;
   * at least 3) from the next invoice: if Paddle fails, 502 and nothing changes.
   */
  router.delete(
    '/companies/:id/members/:personId',
    requireAgent,
    json(async (req) => {
      const me = agentOf(req)!;
      const id = String(req.params.id);
      const personId = String(req.params.personId);
      const self = personId === me.id;
      // Reauthorize, revalidate and claim the removal in one transaction, so a duplicate or concurrent removal of the same
      // person gets 404/409 and Paddle is called once. Paddle is called outside any transaction (callbacks may retry).
      const now = Date.now();
      const claim = await db.runTransaction(async (tx) => {
        const target = (await tx.get(agents.doc(personId))).data() as AgentRecord | undefined;
        const rec = (await tx.get(billing.doc(id))).data() as BillingRecord | undefined;
        const owns = self && !!rec?.owners?.includes(me.id);
        if (!self && !rec?.owners?.includes(me.id)) throw new HubError('forbidden', "Only the company's owners remove members");
        if (owns && rec!.owners!.length === 1) {
          const linked = (await tx.get(agents.where('billingAccountId', '==', id))).docs.map((d) => d.id);
          if (!isDraft(rec, me.id, linked)) throw new HubError('conflict', "You're this company's only owner, so you can't leave it");
          tx.delete(billing.doc(id));
          if (target?.billingAccountId === id) tx.update(agents.doc(personId), { billingAccountId: FieldValue.delete() });
          return undefined;
        }
        if (target?.billingAccountId !== id && !owns) throw new HubError('not_found', 'Not a member of this company');
        if (target?.removingAt && now - Date.parse(target.removingAt) < REMOVAL_CLAIM_MS) throw new HubError('conflict', 'This member is already being removed');
        tx.update(agents.doc(personId), { removingAt: new Date(now).toISOString() });
        return { owns };
      });
      if (!claim) return { companyId: id, personId };
      await serial(id, async () => {
        let seats: number | undefined;
        try {
          seats = await lowerSeats(id, personId, claim.owns);
        } catch (err) {
          await agents.doc(personId).update({ removingAt: FieldValue.delete() });
          throw err;
        }
        await db.runTransaction(async (tx) => {
          const target = (await tx.get(agents.doc(personId))).data() as AgentRecord | undefined;
          tx.update(agents.doc(personId), target?.billingAccountId === id ? { billingAccountId: FieldValue.delete(), removingAt: FieldValue.delete() } : { removingAt: FieldValue.delete() });
          if (claim.owns) tx.update(billing.doc(id), { owners: FieldValue.arrayRemove(me.id) });
          // Paddle's subscription.updated confirms it; the next change recounts anyway.
          if (seats !== undefined) tx.update(billing.doc(id), { seats });
        });
        await recount(id);
      });
      return { companyId: id, personId };
    }),
  );
}
