import { me, myBilling } from '@/lib/hub';
import { pricingCta } from '@/lib/pricing';

const PLANS = ['Free', 'Pro', 'Team'] as const;

/** The pricing page's buttons for the person signed in (the page itself is static), or null when nobody is. */
export async function GET() {
  const user = await me();
  const billing = user ? await myBilling().catch(() => undefined) : undefined;
  const flags = { signedIn: true, proLive: Boolean(billing?.paddle?.prices?.pro || process.env.PADDLE_PRO_PRICE_ID), teamLive: Boolean(billing?.paddle?.prices?.team) };
  const cta = user ? Object.fromEntries(PLANS.map((plan) => [plan, pricingCta(plan, flags)])) : null;
  return Response.json({ cta }, { headers: { 'cache-control': 'private, no-store' } });
}
