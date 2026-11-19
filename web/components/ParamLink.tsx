'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import type { ComponentProps } from 'react';

/** A link to this page with one search param set, keeping the rest as the URL has them now (ClientTabs changes ?client= in the browser). */
export function ParamLink({ name, value, ...props }: Omit<ComponentProps<typeof Link>, 'href'> & { name: string; value: string }) {
  const q = new URLSearchParams(useSearchParams());
  q.set(name, value);
  return <Link href={`?${q}`} {...props} />;
}
