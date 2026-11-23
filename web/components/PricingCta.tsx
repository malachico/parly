'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useSignedIn } from './SignedInSwitch';
import { type Cta, ctaFor } from '@/lib/pricingCta';

// One request for the page's three buttons.
let asked: Promise<Record<string, Cta> | null> | undefined;
const signedInCtas = () =>
  (asked ??= fetch('/api/pricing', { cache: 'no-store' })
    .then((r) => r.json() as Promise<{ cta?: Record<string, Cta> | null }>)
    .then((b) => b.cta ?? null, () => null)
    .finally(() => {
      asked = undefined;
    }));

/** A plan's button on the static pricing page: the signed-out one as rendered, the signed-in one once the session is known. */
export function PricingCta({ plan, href, label, className }: Cta & { plan: string; className?: string }) {
  const signedIn = useSignedIn();
  const [mine, setMine] = useState<Cta>();
  useEffect(() => {
    if (!signedIn) return;
    let live = true;
    void signedInCtas().then((c) => live && setMine(c?.[plan]));
    return () => {
      live = false;
    };
  }, [signedIn, plan]);
  const go = ctaFor(signedIn, mine, plan, { href, label });
  return (
    <Link href={go.href} className={className}>
      {go.label}
    </Link>
  );
}
