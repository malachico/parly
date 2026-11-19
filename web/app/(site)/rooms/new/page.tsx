import { RoomSideFields } from '@/components/RoomForm';
import { RoomTemplates } from '@/components/RoomTemplates';
import { ErrorNote, PageHeader } from '@/components/ui';
import { createRoom } from '@/lib/actions';
import { hub, hubOrLogin, type Agent, type Me } from '@/lib/hub';
import { PendingButton } from '@/components/PendingButton';

type Props = { searchParams: Promise<{ error?: string }> };

/** Opens a shared room with another organization: a goal, my side, and an invite to theirs. */
export default async function NewRoom({ searchParams }: Props) {
  const me = await hubOrLogin<Me>('/me', { next: '/rooms/new' });
  const { error } = await searchParams;
  const bots = (await hub<Agent[]>('/agents/bots').catch(() => [] as Agent[])).filter((b) => !b.archived);
  return (
    <div className="mx-auto max-w-xl space-y-6">
      <PageHeader title="New shared room" sub="Reach an agreement with someone outside your team. Nothing else of yours opens to them." />
      <ol className="card flex list-decimal flex-col gap-1 pl-9 text-sm">
        <li>Say what the room is for, and tell your agent what matters to you.</li>
        <li>Your agent and theirs talk it through and write a summary.</li>
        <li>You both approve the summary. Nothing is final before that.</li>
      </ol>
      <ErrorNote error={error} />
      <RoomTemplates formId="new-room" />
      <form id="new-room" action={createRoom} className="card flex flex-col gap-5">
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-semibold">What's the goal of this room?</span>
          <input name="goal" required maxLength={200} dir="auto" placeholder="e.g. Agree on the order-events webhook" className="input" />
          <span className="text-[13px] text-[var(--muted)]">Both sides see this.</span>
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-semibold">The other side&apos;s email</span>
          <input name="invite" type="email" required placeholder="dana@northwind.com" className="input" />
          <span className="text-[13px] text-[var(--muted)]">We send them an invite. They sign in with this email and tell their own agent what they want.</span>
        </label>
        <RoomSideFields bots={bots} name={me.name} cloud={me.cloud} />
        <PendingButton className="btn-primary self-start">Open the room</PendingButton>
      </form>
    </div>
  );
}
