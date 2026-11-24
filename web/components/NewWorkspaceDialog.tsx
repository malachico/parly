'use client';
import { PendingButton } from './PendingButton';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Dialog } from '@/components/Modal';
import { connectSlackNew, createWorkspace, workspaceBilling } from '@/lib/actions';
import type { BillingView } from '@/lib/hub';
import { atPlanCap, planCapMessage } from '@/lib/plan-limits';

/** Make a workspace. Open while the URL has ?workspace=new. Hidden limit gate on self-host (max null). */
export function NewWorkspaceDialog() {
  const params = useSearchParams();
  const router = useRouter();
  const path = usePathname();
  const open = params.get('workspace') === 'new';
  const error = open ? params.get('error') : null;
  // Asked once per opening, not by the layout on every page load. Until it answers the form shows; the hub enforces the limit either way.
  const [billing, setBilling] = useState<BillingView>();
  useEffect(() => {
    if (open) void workspaceBilling().then(setBilling);
  }, [open]);
  const close = () => {
    const next = new URLSearchParams(params.toString());
    next.delete('workspace');
    next.delete('error');
    const qs = next.toString();
    router.replace(`${path}${qs ? `?${qs}` : ''}`, { scroll: false });
  };
  const usage = billing?.workspaces;
  const full = atPlanCap(usage);
  return (
    <Dialog open={open} onClose={close} title="New workspace">
      {error && (
        <p role="alert" className="rounded-lg bg-[var(--bad-bg)] px-3 py-2 text-sm text-[var(--bad-fg)]">
          {error}
        </p>
      )}
      {full && usage?.max != null ? (
        <div role="status" className="flex flex-col gap-3">
          <p className="font-semibold">{planCapMessage('workspaces', { count: usage.count, max: usage.max })}, upgrade to add more</p>
          <p className="text-sm text-[var(--muted)]">
            Your {billing!.plan === 'free' ? 'Free' : billing!.plan === 'pro' ? 'Pro' : 'Team'} plan includes {usage.max} workspace
            {usage.max === 1 ? '' : 's'} you can own. Archive one you don&apos;t use, or upgrade.
          </p>
          <Link href="/billing" className="btn-primary self-end">
            {billing!.plan === 'free' ? 'Upgrade to Pro' : 'Manage plan'}
          </Link>
        </div>
      ) : (
        <>
          <form action={createWorkspace} className="flex flex-col gap-3">
            <p className="text-sm text-[var(--muted)]">
              A workspace is a company or a crew: everyone in it can see and message each other, and channels live inside it. Invite people by
              email or let your company&apos;s email domain in; add your agents by name.
            </p>
            {usage?.max != null && (
              <p className="text-xs text-[var(--muted)]">
                {usage.count}/{usage.max} workspaces on your plan
              </p>
            )}
            <input name="name" dir="auto" required autoFocus maxLength={100} placeholder="Workspace name" aria-label="Workspace name" className="input" autoComplete="off" />
            <PendingButton className="btn-primary self-end">Create</PendingButton>
          </form>
          <form action={connectSlackNew} className="flex items-center justify-between gap-3 border-t border-[var(--border)] pt-3">
            <p className="text-sm text-[var(--muted)]">Or start from your Slack: a workspace with its name, connected.</p>
            <PendingButton className="btn-ghost shrink-0">Connect Slack</PendingButton>
          </form>
        </>
      )}
    </Dialog>
  );
}
