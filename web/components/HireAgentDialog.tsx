'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useFormStatus } from 'react-dom';
import { Dialog } from '@/components/Modal';
import { hireAgent } from '@/lib/actions';
import { atPlanCap, planCapMessage, type PlanUsage } from '@/lib/plan-limits';

function HireSubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      aria-busy={pending}
      className="btn-primary inline-flex items-center justify-center gap-1.5 self-end disabled:opacity-60"
    >
      {pending && (
        <span role="status" aria-label="Working" className="size-3 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent" />
      )}
      {pending ? 'Hiring…' : 'Hire agent'}
    </button>
  );
}

/** Hire a hosted agent in the open workspace. Open while the URL has ?hire=1 or ?hire=new. */
export function HireAgentDialog({
  workspaceId,
  workspaceName,
  participants,
  canUpgrade = false,
}: {
  workspaceId: string;
  workspaceName: string;
  participants?: PlanUsage;
  /** True when the viewer is owners[0] (billing owner); co-owners manage but don't set the cap. */
  canUpgrade?: boolean;
}) {
  const params = useSearchParams();
  const router = useRouter();
  const path = usePathname();
  const hireParam = params.get('hire');
  const open = hireParam === '1' || hireParam === 'new';
  const error = open ? params.get('error') : null;
  const close = () => {
    const next = new URLSearchParams(params.toString());
    next.delete('hire');
    next.delete('error');
    const qs = next.toString();
    router.replace(`${path}${qs ? `?${qs}` : ''}`, { scroll: false });
  };
  const backParams = new URLSearchParams(params.toString());
  backParams.set('hire', '1');
  backParams.delete('error');
  const backHref = `${path}?${backParams.toString()}`;
  const full = atPlanCap(participants);

  return (
    <Dialog open={open} onClose={close} title="Hire an agent">
      {error && (
        <p role="alert" className="rounded-lg bg-[var(--bad-bg)] px-3 py-2 text-sm text-[var(--bad-fg)]">
          {error}
        </p>
      )}
      {full && participants?.max != null ? (
        <div role="status" className="flex flex-col gap-3">
          <p className="font-semibold">
            {planCapMessage('participants', { count: participants.count, max: participants.max })}
            {canUpgrade ? ', upgrade to add more' : ''}
          </p>
          <p className="text-sm text-[var(--muted)]">
            {canUpgrade
              ? 'Remove someone or archive an agent, or upgrade your plan.'
              : 'Remove someone or archive an agent, or ask the workspace owner to upgrade.'}
          </p>
          {canUpgrade && (
            <Link href="/billing" className="btn-primary self-end">
              Upgrade
            </Link>
          )}
        </div>
      ) : (
        <HireAgentForm workspaceId={workspaceId} workspaceName={workspaceName} back={backHref} />
      )}
    </Dialog>
  );
}

/** Streamlined 1-step form to hire a hosted agent on Parly. */
export function HireAgentForm({
  workspaceId,
  workspaceName,
  back,
}: {
  workspaceId: string;
  workspaceName?: string;
  back: string;
}) {
  return (
    <form action={hireAgent.bind(null, workspaceId, back)} className="flex flex-col gap-3">
      <p className="text-sm text-[var(--muted)]">
        Give your agent a name. It gets its own computer on Parly{workspaceName ? ` in ${workspaceName}` : ''}, and wakes whenever you message it.
      </p>
      <label htmlFor="hire-agent-name" className="label">
        Name
      </label>
      <input
        id="hire-agent-name"
        name="name"
        dir="auto"
        required
        autoFocus
        maxLength={64}
        placeholder="e.g. Maya, Alex, Researcher…"
        aria-label="Agent name"
        className="input"
        autoComplete="off"
      />
      <p className="text-xs text-[var(--muted)]">Uses your credits while working. Sleeps automatically when idle.</p>
      <HireSubmitButton />
    </form>
  );
}
