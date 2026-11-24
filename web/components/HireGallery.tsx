'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { credits } from '@/lib/labels';
import { hireByType } from '@/lib/actions';
import type { BillingView, Channel } from '@/lib/hub';
import { atPlanCap, planCapMessage, type PlanUsage } from '@/lib/plan-limits';
import { PendingButton } from '@/components/PendingButton';

const upgradeHref = '/billing';

const AGENT_NAMES = ['Maya', 'Atlas', 'Scout', 'Nova', 'Kai', 'Juno', 'Iris', 'Leo', 'Milo', 'Zoe'] as const;

function randomAgentName(random: () => number = Math.random): string {
  return AGENT_NAMES[Math.floor(random() * AGENT_NAMES.length)]!;
}

/**
 * Hiring, the heart of what Parly sells: a name (prefilled at random), the team it joins, and a type when there's more than one. A
 * cloud agent thinks and writes (every plan); an agent with its own computer runs code and browses (Pro, or a super admin). At the
 * workspace participant cap, hiring turns into one clear way up.
 */
export function HireGallery({
  ws,
  billing,
  participants,
  canUpgrade = false,
  cloud,
  computers,
  admin = false,
  teams = [],
  team,
}: {
  ws: string;
  billing?: BillingView;
  /** This workspace's seat usage; hiring is blocked at the cap (self-host: max null). */
  participants?: PlanUsage;
  /** Viewer is owners[0] (billing owner); co-owners manage but don't set the cap. */
  canUpgrade?: boolean;
  cloud: boolean;
  computers: boolean;
  /** A super admin: hires agents with their own computer on any plan, past the plan's limit. */
  admin?: boolean;
  /** The workspace's teams I'm in; the new agent joins `team` (the one it was made from), else the first. */
  teams?: Channel[];
  team?: string;
}) {
  const [name, setName] = useState('');
  useEffect(() => {
    setName((c) => c || randomAgentName());
  }, []);
  const free = !billing || billing.plan === 'free';
  const atLimit = !admin && atPlanCap(participants);
  const proLive = Boolean(billing?.paddle?.prices?.pro);
  const computerLocked = free && !admin;

  if (atLimit && participants?.max != null)
    return (
      <div role="status" className="flex flex-col gap-3 rounded-2xl border border-[var(--accent)] bg-[var(--accent-soft)] p-5 sm:flex-row sm:items-center">
        <div className="min-w-0 flex-1">
          <p className="font-semibold">
            {planCapMessage('participants', { count: participants.count, max: participants.max })}
            {canUpgrade ? ', upgrade to add more' : ''}
          </p>
          <p className="text-[13px] text-[var(--fg-soft)]">
            {canUpgrade
              ? 'Remove someone you don\'t need, or upgrade the plan that owns this workspace.'
              : 'Remove someone you don\'t need, or ask the workspace owner to upgrade.'}
          </p>
        </div>
        {canUpgrade && (
          <Link href={upgradeHref} className="btn-primary shrink-0 justify-center">
            Upgrade
          </Link>
        )}
      </div>
    );

  const option = 'flex cursor-pointer flex-col gap-1.5 rounded-2xl border-2 border-[var(--border)] bg-[var(--surface)] p-4 has-[:checked]:border-[var(--accent)] has-[:checked]:bg-[var(--accent-soft)]';
  // Locked (Free): a dark Pro card that sells the upgrade instead of a greyed-out option.
  const locked = 'relative flex flex-col gap-1.5 overflow-hidden rounded-2xl border-2 border-[#17161c] bg-[#17161c] p-4 text-[#f6f5f2]';
  return (
    <form action={hireByType.bind(null, ws)} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block space-y-1.5">
          <span className="label">Name</span>
          <input
            id="hire-name"
            name="name"
            required
            maxLength={64}
            autoComplete="off"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Maya, Atlas, Scout"
            className="input text-base"
          />
        </label>
        {teams.length > 0 && (
          <label className="block space-y-1.5">
            <span className="label">Team</span>
            <select name="channelId" defaultValue={teams.some((t) => t.id === team) ? team : teams[0]!.id} className="input text-base">
              {teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {/* One type on offer (computers off: Admin → Clients → hire): no picker, a name is all it takes. */}
      {cloud && computers ? (
        <fieldset className="space-y-1.5">
          <legend className="label mb-1.5">Type</legend>
          <div className="grid gap-3 sm:grid-cols-2">
            {cloud && (
              <label className={option}>
                <span className="flex items-center gap-2">
                  <input type="radio" name="type" value="cloud" defaultChecked className="size-4 accent-[var(--accent)]" />
                  <span className="font-semibold">Cloud agent</span>
                </span>
                <span className="text-[13px] text-[var(--fg-soft)]">Thinks and writes: plans, research, drafts, reviews. Answers in seconds.</span>
                <span className="text-xs text-[var(--muted)]">Every plan{free ? ' · tools with Pro' : ' · with your tools'}</span>
              </label>
            )}
            {computers && (
              <label className={computerLocked ? locked : option}>
                <span className="flex items-center gap-2">
                  {!computerLocked && <input type="radio" name="type" value="computer" defaultChecked={!cloud} className="size-4 accent-[var(--accent)]" />}
                  <span className="font-semibold">With its own computer</span>
                  <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold tracking-wide uppercase ${computerLocked ? 'bg-[var(--bg)] text-[var(--fg)]' : 'bg-[var(--accent)] text-white'}`}>Pro</span>
                </span>
                <span className={`text-[13px] ${computerLocked ? 'text-[#c9c7d1]' : 'text-[var(--fg-soft)]'}`}>Runs code, uses a browser, keeps its files. Wakes when you message it, sleeps when idle.</span>
                {computerLocked && (
                  <Link href={upgradeHref} className="mt-1 self-start text-[13px] font-semibold text-[#f6f5f2] underline-offset-2 hover:underline">
                    {proLive ? 'Upgrade to Pro · $20/month →' : 'Join the Pro waitlist · $20/mo →'}
                  </Link>
                )}
              </label>
            )}
          </div>
        </fieldset>
      ) : (
        <input type="hidden" name="type" value={cloud ? 'cloud' : 'computer'} />
      )}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-[var(--muted)]">It uses your credits when it works. You can change all of this later.</p>
        <PendingButton className="btn-primary min-h-11 px-6 text-base">Create</PendingButton>
      </div>
    </form>
  );
}

/** Your plan, one line, at the top: owned workspaces and credits used, and the way up. */
export function PlanStrip({ billing }: { billing: BillingView }) {
  const name = { free: 'Free', pro: 'Pro', team: 'Team', enterprise: 'Enterprise' }[billing.plan];
  const pct = Math.min(100, Math.round(billing.used * 100));
  const proLive = Boolean(billing.paddle?.prices?.pro);
  const ws = billing.workspaces;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-2xl border border-[var(--border)] bg-[var(--surface)] px-4 py-3 text-[13px]">
      <span className="rounded-full bg-[var(--accent-soft)] px-2.5 py-0.5 text-xs font-semibold text-[var(--accent)]">{name}</span>
      {ws?.max != null && (
        <span>
          <b>
            {ws.count}/{ws.max}
          </b>{' '}
          workspace{ws.max === 1 ? '' : 's'}
        </span>
      )}
      <span className="flex items-center gap-2">
        <span className="h-1.5 w-20 overflow-hidden rounded-full bg-[var(--subtle)]">
          <span className={`block h-full rounded-full ${pct >= 100 ? 'bg-[var(--bad-fg)]' : pct >= 80 ? 'bg-amber-500' : 'bg-[var(--accent)]'}`} style={{ width: `${pct}%` }} />
        </span>
        {billing.monthlyUsd === undefined ? `Team · covered by ${billing.billedTo?.name ?? 'your company'}` : `${pct}% of ${credits(billing.monthlyUsd + (billing.extraUsd ?? 0))} credits`}
      </span>
      {billing.plan === 'free' && (
        <Link href={upgradeHref} className="ml-auto font-semibold text-[var(--accent)] hover:underline">
          {proLive ? 'Upgrade to Pro →' : 'Join Pro waitlist →'}
        </Link>
      )}
    </div>
  );
}
