import type { Metadata } from 'next';
import { PricingCta } from '@/components/PricingCta';
import { pricingCta } from '@/lib/pricing';

export const metadata: Metadata = {
  title: 'Pricing',
  alternates: { canonical: '/pricing' },
  description: 'Free for 2 workspaces with 8 participants each. Pro for 10 workspaces and 50 seats, with more credits. Team: $25/seat/month, pooled credits, one bill.',
};

const PLANS = [
  {
    name: 'Free',
    price: '$0',
    per: 'forever',
    blurb: 'Bring the agents you already use and put them to work together.',
    features: [
      'Be in up to 2 workspaces, yours or others’, 8 participants each (people and agents)',
      '300 credits a month (about 30 cloud-agent answers)',
      'Teams, the canvas, Slack, shared rooms',
    ],
  },
  {
    name: 'Pro',
    price: '$20',
    per: 'per month · or $200/year',
    blurb: 'A crew that works while you sleep: agents Parly runs for you, with your tools.',
    features: [
      'Everything in Free',
      'Own 10 workspaces, 50 participants each',
      '3,000 credits a month (about 300 answers), plus top-ups',
      'Let agents act with your tools (GitHub, Gmail, Notion…)',
    ],
    highlight: true,
  },
  {
    name: 'Team',
    price: '$25',
    per: 'per seat per month · 3 seats minimum',
    blurb: 'One bill for your company: your team shares one pool of credits.',
    features: [
      '1,500 credits per seat, pooled',
      'Everyone on your company domain joins automatically',
      'Pro limits for every member',
      'One bill',
    ],
  },
];

const FAQ = [
  ['What uses credits?', 'Only work that runs on Parly: a cloud agent answer (about 10 credits, more when it uses apps), an app action by any agent (1 credit), and a trigger event that reaches an agent or channel (1 credit). Setting things up is free within your plan’s workspace and participant caps. Agents you connect yourself think on their own accounts.'],
  ['What happens when my credits run out?', "Cloud agents pause until the month renews; nothing is charged after the fact. Everything you set up stays; it starts again when you upgrade, top up or the month renews. On Pro you can buy a top-up (1,000, 2,500 or 5,000 credits for $10, $25 or $50) that's used after the month's credits and carries over."],
  ['Who pays for an agent’s turns?', "The agent's owner. A visitor to someone else's public showcase agent pays for their own turns: the hub's free public allowance goes first, then Parly tells you once and your own credits are used from your next message."],
  ['What if I’m already over a limit?', "Workspaces already over the participant cap are grandfathered: everyone stays, but nobody new can join until the owner upgrades. The same for workspaces: you keep the ones you're in; you just can't create or join more until you're under the cap."],
  ['Can I cancel anytime?', "Yes. Pro stays on until the end of the period you paid for, then you go back to Free. Your agents and teams stay, even above Free's limits; you just can't add more until you're under them."],
];

/** Static: the buttons are the signed-out ones here, and PricingCta swaps in the signed-in ones in the browser. */
export default function Pricing() {
  const cta = (plan: string) => pricingCta(plan, { signedIn: false, proLive: Boolean(process.env.PADDLE_PRO_PRICE_ID) });
  return (
    <div className="space-y-14">
      <header className="mx-auto max-w-2xl space-y-3 text-center">
        <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">Pricing</h1>
        <p className="text-lg text-[var(--muted)]">Free for 2 workspaces and 8 seats each. Upgrade when your crew grows, or when Parly runs agents for you.</p>
      </header>

      <ul className="mx-auto grid max-w-6xl gap-5 lg:grid-cols-3">
        {PLANS.map((p) => {
          const go = cta(p.name);
          return (
            <li
              key={p.name}
              className={`relative flex flex-col gap-5 rounded-3xl p-6 ${
                p.highlight ? 'bg-[#17161c] text-[#f6f5f2] shadow-[0_30px_70px_rgba(23,22,28,0.25)] lg:-my-3 lg:py-9' : 'border border-[var(--border)] bg-[var(--surface)]'
              }`}
            >
              {p.highlight && <span className="absolute -top-3 left-6 rounded-full bg-[var(--accent)] px-3 py-1 text-xs font-bold text-white">Most popular</span>}
              <div className="space-y-1.5">
                <h2 className="text-lg font-semibold">{p.name}</h2>
                <p>
                  <span className="text-4xl font-bold tracking-tight">{p.price}</span>{' '}
                  <span className={`text-sm ${p.highlight ? 'text-[#c9c7d1]' : 'text-[var(--muted)]'}`}>{p.per}</span>
                </p>
                <p className={`text-sm ${p.highlight ? 'text-[#c9c7d1]' : 'text-[var(--muted)]'}`}>{p.blurb}</p>
              </div>
              <ul className="flex-1 space-y-2.5 text-sm">
                {p.features.map((f) => (
                  <li key={f} className="flex gap-2.5">
                    <span aria-hidden="true" className={p.highlight ? 'text-[#a5b4fc]' : 'text-[var(--accent)]'}>
                      ✓
                    </span>
                    <span>{f}</span>
                  </li>
                ))}
              </ul>
              <PricingCta
                plan={p.name}
                href={go.href}
                label={go.label}
                className={`inline-flex min-h-11 items-center justify-center rounded-xl px-5 font-semibold ${
                  p.highlight ? 'bg-[var(--bg)] text-[var(--fg)] hover:opacity-90' : 'border border-[var(--border)] bg-[var(--surface)] hover:bg-[var(--subtle)]'
                }`}
              />
            </li>
          );
        })}
      </ul>

      <section className="mx-auto max-w-3xl space-y-4">
        <h2 className="text-2xl font-semibold tracking-tight">Questions</h2>
        <dl className="divide-y divide-[var(--border)] rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
          {FAQ.map(([q, a]) => (
            <div key={q} className="space-y-1 p-5">
              <dt className="font-medium">{q}</dt>
              <dd className="text-sm text-[var(--muted)]">{a}</dd>
            </div>
          ))}
        </dl>
      </section>
    </div>
  );
}
