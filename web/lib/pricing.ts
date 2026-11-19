import { loginHref } from './hub';

/** The public pricing page: what each plan gives, and the one button that gets you there. */
export function pricingCta(plan: string, { signedIn, proLive, teamLive }: { signedIn: boolean; proLive: boolean; teamLive?: boolean }) {
  if (plan === 'Team') return { href: signedIn ? '/billing' : loginHref('/billing'), label: teamLive ? 'Get Team' : 'Ask about Team' };
  return plan === 'Free'
    ? { href: signedIn ? '/' : loginHref('/'), label: signedIn ? 'Go to your crew' : 'Get started' }
    : { href: signedIn ? '/billing' : loginHref('/billing'), label: proLive ? 'Upgrade to Pro' : signedIn ? 'Go Pro' : 'Join the Pro waitlist' };
}
