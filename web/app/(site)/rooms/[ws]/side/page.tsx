import { redirect } from 'next/navigation';
import { RoomSideFields } from '@/components/RoomForm';
import { ErrorNote, PageHeader } from '@/components/ui';
import { logout, setupRoomSide } from '@/lib/actions';
import { channelKey, hub, hubOrLogin, type Agent, type Me } from '@/lib/hub';
import { chatHref } from '@/lib/routes';
import { PendingButton } from '@/components/PendingButton';

type Props = { params: Promise<{ ws: string }>; searchParams: Promise<{ error?: string }> };

/** Someone invited to a shared room sets up their side: its name, representatives and brief. */
export default async function RoomSide({ params, searchParams }: Props) {
  const { ws } = await params;
  const { error } = await searchParams;
  const user = await hubOrLogin<Me>('/me', { next: `/rooms/${encodeURIComponent(ws)}/side` });
  const workspace = user.workspaces.find((w) => w.id === ws);
  if (!workspace?.room) {
    // Most often the invite link, opened from another account: an invite belongs to one email.
    return (
      <div className="mx-auto max-w-xl space-y-6">
        <PageHeader title="This invite is for another email" sub={`You're signed in${user.email ? ` as ${user.email}` : ''}. Sign in with the email the invite was sent to, or ask the person who invited you to check the address.`} />
        <form action={logout}>
          <PendingButton className="btn-primary">Sign out</PendingButton>
        </form>
      </div>
    );
  }
  // Already on a side: straight into the room.
  if (workspace.room.mySide) redirect(chatHref(ws, channelKey(workspace.room.shared)));
  const bots = (await hub<Agent[]>('/agents/bots').catch(() => [] as Agent[])).filter((b) => !b.archived);
  const others = workspace.room.sides.map((s) => s.name).join(', ');
  return (
    <div className="mx-auto max-w-xl space-y-6">
      <PageHeader title="Join a shared room" sub={others ? `${others} invited you to work this out together.` : 'You were invited to a shared room.'} />
      <ErrorNote error={error} />
      <div className="card flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <span className="text-[13px] text-[var(--muted)]">Goal of the room</span>
          <span className="text-lg font-semibold" dir="auto">
            {workspace.room.goal}
          </span>
        </div>
        <ol className="flex list-decimal flex-col gap-1 pl-5 text-sm">
          <li>Tell your agent below what you want and what you won&apos;t compromise on.</li>
          <li>Your agent talks with theirs, writes a summary, and asks you when it&apos;s your call.</li>
          <li>Nothing is final until you approve it for your side.</li>
        </ol>
        <p className="text-[13px] text-[var(--muted)]">They never see your instructions, your private chat with your agent, or anything else of yours.</p>
      </div>
      <form action={setupRoomSide.bind(null, ws)} className="card flex flex-col gap-5">
        <RoomSideFields bots={bots} name={user.name} cloud={user.cloud} />
        <PendingButton className="btn-primary self-start">Join the room</PendingButton>
      </form>
    </div>
  );
}
