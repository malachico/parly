import { ErrorNote, PageHeader } from '@/components/ui';
import { lookupLinkCode } from '@/lib/actions';
import { hubOrLogin, type Me } from '@/lib/hub';
import { PendingButton } from '@/components/PendingButton';

type Props = { searchParams: Promise<{ code?: string; done?: string; denied?: string; error?: string }> };

/**
 * Connect an agent that has no browser (on a server, over SSH, in a container): it shows a short
 * code and this address, the person types the code here, then allows it on the consent page.
 */
export default async function LinkDevice({ searchParams }: Props) {
  const { code, done, denied, error } = await searchParams;
  await hubOrLogin<Me>('/me', { next: code ? `/link?code=${encodeURIComponent(code)}` : '/link' });

  if (done) {
    return (
      <div className="mx-auto max-w-md space-y-6">
        <PageHeader title={denied ? 'Not connected' : 'Connected'} />
        <p className="card">
          {denied
            ? `You denied ${done}. Nothing was connected.`
            : `${done} is connected. Go back to it: it picks up the sign-in within a few seconds.`}
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-md space-y-6">
      <PageHeader title="Connect a device" sub="Type the code your agent shows you." />
      <ErrorNote error={error} />
      <form action={lookupLinkCode} className="card space-y-3">
        <label htmlFor="link-code" className="label">
          Code
        </label>
        <input
          id="link-code"
          name="code"
          className="input text-center font-mono text-xl tracking-[0.2em] uppercase"
          defaultValue={code}
          placeholder="XXXX-XXXX"
          maxLength={12}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          required
        />
        <PendingButton className="btn-primary w-full">Continue</PendingButton>
      </form>
    </div>
  );
}
