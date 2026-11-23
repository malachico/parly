import { redirect } from 'next/navigation';
import { currentWorkspace, meOrLogin } from '@/lib/hub';
import { wsHref } from '@/lib/routes';

type Props = { searchParams: Promise<Record<string, string | undefined>> };

/**
 * "/" for someone signed in (proxy.ts rewrites it here, so the landing at "/" stays static): the workspace you had
 * open last (or your first), with any dialog params (?find=, ?channel=new) carried along.
 */
export default async function Home({ searchParams }: Props) {
  const user = await meOrLogin();
  const workspace = await currentWorkspace(user);
  // Everyone gets a workspace on sign-in; a person in none (every one left) makes a new one.
  if (!workspace) redirect('/account?noworkspace=1');
  redirect(wsHref(workspace.id, await searchParams));
}
