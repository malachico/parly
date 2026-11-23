export type Cta = { href: string; label: string };

/** Signed in: /api/pricing's button, and until it answers (or if it fails) the rendered label going where someone signed in goes. */
export const ctaFor = (signedIn: boolean | undefined, mine: Cta | undefined, plan: string, out: Cta): Cta =>
  signedIn ? (mine ?? { href: plan === 'Free' ? '/' : '/billing', label: out.label }) : out;
