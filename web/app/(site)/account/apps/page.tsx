import { redirect } from 'next/navigation';
import { currentWorkspace, meOrLogin } from '@/lib/hub';
import { appsHref } from '@/lib/routes';

/** Old link: Apps is a panel in your workspace now. */
export default async function OldApps() {
  const ws = await currentWorkspace(await meOrLogin());
  redirect(ws ? appsHref(ws.id) : '/account?noworkspace=1');
}
