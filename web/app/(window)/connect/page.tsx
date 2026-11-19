import { redirect } from 'next/navigation';
import { currentWorkspace, hubOrLogin, type Me } from '@/lib/hub';

/** Old links and the connect actions' returns: Connect lives over the canvas now (/w/<ws>/connect), same query. */
export default async function ConnectRedirect({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const query = new URLSearchParams(await searchParams).toString();
  const user = await hubOrLogin<Me>('/me', { next: `/connect${query ? `?${query}` : ''}` });
  const ws = (await currentWorkspace(user))?.id;
  redirect(ws ? `/w/${encodeURIComponent(ws)}/connect${query ? `?${query}` : ''}` : '/');
}
