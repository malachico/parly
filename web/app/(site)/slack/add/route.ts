import { redirect } from 'next/navigation';
import { hub, HubError, loginHref, token } from '@/lib/hub';

/**
 * "Add Parly to Slack" from the landing page: sign in first (and come back here), then Slack's approval through
 * /slack/install, so the install is bound to this person's session. A new crew's home is made from the Slack team.
 */
export async function GET() {
  if (!(await token())) redirect(loginHref('/slack/add'));
  let url: string;
  try {
    ({ url } = await hub<{ url: string }>('/slack/install', { method: 'POST', body: { workspaceId: '' } }));
  } catch (err) {
    if (err instanceof HubError) redirect(`/?error=${encodeURIComponent(err.message)}`);
    throw err;
  }
  redirect(url);
}
