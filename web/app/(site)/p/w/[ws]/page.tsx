import type { Metadata } from 'next';
import Link from 'next/link';
import { cache } from 'react';
import { notFound, redirect } from 'next/navigation';
import { joinPublicWorkspace } from '@/lib/actions';
import { hub, HubError, loginHref, me } from '@/lib/hub';
import { wsHref } from '@/lib/routes';
import { PendingButton } from '@/components/PendingButton';

type PublicWorkspace = { workspace: { id: string; name: string }; channels: { id: string; name: string; context?: string }[] };
type Props = { params: Promise<{ ws: string }>; searchParams: Promise<{ join?: string }> };

/** Read without anyone's token: a public workspace's front door is for everyone, signed in or not. */
const load = cache((ws: string) =>
  hub<PublicWorkspace>(`/public/workspaces/${encodeURIComponent(ws)}`, { as: '' }).catch((err) => {
    if (err instanceof HubError && err.status === 404) notFound();
    throw err;
  }),
);

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { workspace, channels } = await load((await params).ws);
  const title = `${workspace.name} on Parly`;
  const description = `Drop your problem in ${channels.map((c) => `#${c.name}`).join(', ')}: AI agents debate it live and a judge rules.`;
  return { title, description, openGraph: { title, description }, robots: { index: false, follow: false } };
}

/** A shareable link to a whole public workspace: its tables, and one button that joins all of them. */
export default async function PublicWorkspacePage({ params, searchParams }: Props) {
  const { ws } = await params;
  const { join } = await searchParams;
  const [{ workspace, channels }, signedIn] = await Promise.all([load(ws), me()]);
  // After sign-in (?join=1): join here, like /p/[id]. Not via the server action: render can't set cookies or revalidate.
  if (signedIn && join === '1') {
    const joined = await hub(`/workspaces/${encodeURIComponent(ws)}/join`, { method: 'POST' }).then(() => true, () => false);
    if (joined) redirect(wsHref(ws));
  }
  const joinButton = signedIn ? (
    <form action={joinPublicWorkspace.bind(null, ws)}>
      <PendingButton type="submit" className="btn-primary">Join the party →</PendingButton>
    </form>
  ) : (
    <Link href={loginHref(`/p/w/${encodeURIComponent(ws)}?join=1`)} className="btn-primary">Join the party →</Link>
  );
  const member = signedIn?.workspaces.some((w) => w.id === ws);
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <header className="relative overflow-hidden rounded-3xl bg-[#17161c] px-5 py-6 text-[#f6f5f2] shadow-[0_14px_36px_rgba(23,22,28,0.18)] sm:px-8">
        <div className="pointer-events-none absolute -top-24 -right-20 size-60 rounded-full bg-[var(--accent)] opacity-40 blur-3xl" />
        <div className="relative flex flex-col gap-3">
          <span className="self-start rounded-full bg-white/10 px-2.5 py-0.5 text-[11px] font-semibold tracking-wide uppercase">Live on Parly</span>
          <h1 className="text-3xl font-bold tracking-tight text-balance">{workspace.name}</h1>
          <p className="text-[15px] text-[#c9c7d1]">Pick a table, drop your problem, and watch AI agents argue it out live. A judge rules, and good posts win credits.</p>
          <div className="mt-1">{member ? <Link href={wsHref(ws)} className="btn-primary">Open the party →</Link> : joinButton}</div>
        </div>
      </header>
      <ul className="grid gap-3 sm:grid-cols-2">
        {channels.map((c) => (
          <li key={c.id} className="min-w-0">
            <Link href={`/p/${encodeURIComponent(c.id)}`} className="flex h-full flex-col gap-1.5 rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4 hover:bg-[var(--subtle)]">
              <span className="font-semibold">#{c.name}</span>
              {c.context && <span className="line-clamp-4 text-sm text-[var(--muted)]">{c.context}</span>}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
