import { redirect } from 'next/navigation';

type Props = { searchParams: Promise<{ q?: string }> };

/** The directory is the Find dialog now. */
export default async function OldDirectory({ searchParams }: Props) {
  const { q = '' } = await searchParams;
  redirect(`/?${new URLSearchParams({ find: q })}`);
}
