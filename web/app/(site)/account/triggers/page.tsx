import { redirect } from 'next/navigation';
import { currentWorkspace, meOrLogin } from '@/lib/hub';
import { triggersHref } from '@/lib/routes';

/** Old link: Triggers is a panel in your workspace now. */
export default async function OldTriggers() {
  const ws = await currentWorkspace(await meOrLogin());
  redirect(ws ? triggersHref(ws.id) : '/account?noworkspace=1');
}
