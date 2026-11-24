import { PendingButton } from '@/components/PendingButton';
import { acceptCompanyInvite, dropCompanyInvite, inviteToCompany, removeCompanyMember } from '@/lib/actions';
import type { CompanyInviteView, CompanyMemberView, CompanyOwnerView, CompanyView } from '@/lib/hub';
import { credits } from '@/lib/labels';

const Hidden = ({ name, value }: { name: string; value: string }) => <input type="hidden" name={name} value={value} />;

/** Owner: who the company pays for, pending invites (each holds a seat) and an invite form. */
function Owner({ company }: { company: CompanyOwnerView }) {
  const { seats } = company;
  const full = seats.max !== null && seats.used >= seats.max;
  return (
    <section id="company-members" className="card scroll-mt-6 space-y-3" aria-label="Company members">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="label">Company members</p>
          <h2 className="text-xl font-semibold">{company.name}</h2>
        </div>
        <p className="muted text-right text-[13px]">
          {seats.used} of {seats.max ?? 'unlimited'} seats used
          <br />
          {credits(company.leftUsd)} credits left{company.budgetCredits != null ? ` · budget ${company.budgetCredits.toLocaleString()}` : ''}
        </p>
      </div>
      <ul className="divide-y divide-[var(--border)] text-sm">
        {company.members.map((m) => (
          <li key={m.id} className="flex items-center justify-between gap-2 py-1.5">
            <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{m.name}{m.email ? <span className="muted"> · {m.email}</span> : null}</span>
            <span className="muted">{credits(m.spentUsd)} this month</span>
            {!m.owner && (
              <form action={removeCompanyMember}>
                <Hidden name="companyId" value={company.id} />
                <Hidden name="personId" value={m.id} />
                <PendingButton confirm="Yes, remove" className="btn-ghost text-[13px] text-[var(--bad-fg)]" aria-label={`Remove ${m.name}`}>Remove</PendingButton>
              </form>
            )}
          </li>
        ))}
        {company.invites.map((i) => (
          <li key={i.email} className="flex items-center justify-between gap-2 py-1.5">
            <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{i.email}</span>
            <span className="muted">invited</span>
            <form action={dropCompanyInvite}>
              <Hidden name="companyId" value={company.id} />
              <Hidden name="email" value={i.email} />
              <PendingButton className="btn-ghost text-[13px]" aria-label={`Revoke invite for ${i.email}`}>Revoke</PendingButton>
            </form>
          </li>
        ))}
        {!company.seats.used && <li className="muted py-1.5">No one yet. Invite people by email.</li>}
      </ul>
      {full ? (
        <p className="muted text-sm">Every seat is taken. Add seats to invite more people.</p>
      ) : (
        <form action={inviteToCompany} className="flex gap-2">
          <Hidden name="companyId" value={company.id} />
          <input name="email" type="email" required placeholder="name@company.com" aria-label="Email to invite" className="input min-w-0 flex-1" />
          <PendingButton className="btn-primary">Invite</PendingButton>
        </form>
      )}
    </section>
  );
}

/** A member: who pays for their agents (only while the plan is active), and leaving. */
function Member({ company, me }: { company: CompanyMemberView; me: string }) {
  return (
    <section className="flex items-center justify-between gap-3 rounded-lg bg-[var(--subtle)] px-3 py-2 text-sm" aria-label="Company">
      <p role="status">{company.active ? `${company.name} pays for your agents.` : `You're a member of ${company.name}.`}</p>
      <form action={removeCompanyMember}>
        <Hidden name="companyId" value={company.id} />
        <Hidden name="personId" value={me} />
        <PendingButton confirm="Yes, leave" className="btn-ghost text-[13px] text-[var(--bad-fg)]">Leave</PendingButton>
      </form>
    </section>
  );
}

/** Invites to your email: accepting moves you out of any company you're in now. */
function Invites({ invites, current, email }: { invites: CompanyInviteView[]; current?: string; email: string }) {
  return (
    <section className="card space-y-2" aria-label="Company invites">
      <h2 className="font-semibold">Company invites</h2>
      {invites.map((i) => (
        <div key={i.companyId} className="flex flex-wrap items-center justify-between gap-2 text-sm">
          <p className="min-w-0 flex-1">
            <strong>{i.companyName}</strong>
            {i.invitedByName ? ` (from ${i.invitedByName})` : ''} wants to pay for your agents.
            {current && current !== i.companyId && <span className="block text-[var(--warn-fg)]">Accepting moves you out of your current company.</span>}
          </p>
          <form action={acceptCompanyInvite}>
            <Hidden name="companyId" value={i.companyId} />
            <PendingButton className="btn-primary text-[13px]">Accept</PendingButton>
          </form>
          <form action={dropCompanyInvite}>
            <Hidden name="companyId" value={i.companyId} />
            <Hidden name="email" value={email} />
            <PendingButton className="btn-ghost text-[13px]">Decline</PendingButton>
          </form>
        </div>
      ))}
    </section>
  );
}

export function CompanyCard({ company, invites, me }: { company: CompanyView | null; invites: CompanyInviteView[]; me: { id: string; email?: string } }) {
  return (
    <>
      {company?.member && <Member company={company.member} me={me.id} />}
      {invites.length > 0 && me.email && <Invites invites={invites} current={company?.member?.id} email={me.email} />}
      {company?.owned.map((o) => <Owner key={o.id} company={o} />)}
    </>
  );
}
