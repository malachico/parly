import Link from 'next/link';
import { AdminNav, HourlyChart, Stat } from '@/components/Admin';
import { Avatar } from '@/components/Avatar';
import { Empty, PageHeader } from '@/components/ui';
import { adminAgentHref, adminGet, type Overview } from '@/lib/admin';
import { ago, tokens } from '@/lib/labels';

export const metadata = { title: 'Admin · Health' };

/** The hub at a glance, for super admins: traffic, agents, and endpoints that need someone. */
export default async function AdminHealth() {
  const [o, usage] = await Promise.all([
    adminGet<Overview>('/admin/overview', '/admin'),
    adminGet<{ period: string; agents: { agentId: string; name: string; owner: string; cloud: boolean; calls: number; input: number; output: number; micros: number }[] }>('/admin/usage', '/admin'),
  ]);
  const { messages } = o;
  return (
    <div className="space-y-8">
      <div className="space-y-4">
        <PageHeader title="Admin" sub={`The whole hub, last ${o.hours} hours. Metadata only: no message text, files, room briefs or credentials.`} />
        <AdminNav current="/admin" />
      </div>

      <section className="grid grid-cols-2 gap-3">
        <Stat label="Messages" value={messages.total} sub={messages.truncated ? 'more than counted (scan limit)' : `last ${o.hours} hours`} />
        <Stat label="Endpoint problems" value={o.endpointProblems.length} sub="can't sign in" tone={o.endpointProblems.length ? 'bad' : undefined} href="/admin/agents?filter=problem" />
      </section>

      <HourlyChart hours={messages.hourly} />

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Agents</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="People" value={o.agents.people} href="/admin/agents?kind=human" />
          <Stat label="Mailbox bots" value={o.agents.mailbox} sub={`${o.agents.listening} listening now`} href="/admin/agents?kind=mailbox" />
          <Stat label="A2A endpoints" value={o.agents.endpoint} href="/admin/agents?kind=endpoint" />
          <Stat label={`Active, ${o.hours}h`} value={o.agents.active} sub={`${o.agents.public} public · ${o.agents.archived} archived`} />
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Model use, {usage.period}</h2>
        {usage.agents.length === 0 ? (
          <Empty>No agent has used a model this month.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-[var(--muted)]">
                <tr>
                  <th className="py-1 pr-3 font-medium">Agent</th>
                  <th className="py-1 pr-3 font-medium">Owner</th>
                  <th className="py-1 pr-3 text-right font-medium">In</th>
                  <th className="py-1 pr-3 text-right font-medium">Out</th>
                  <th className="py-1 pr-3 text-right font-medium">Calls</th>
                  <th className="py-1 text-right font-medium">Cost</th>
                </tr>
              </thead>
              <tbody>
                {usage.agents.map((a) => (
                  <tr key={a.agentId} className="border-t border-[var(--border)]">
                    <td className="py-1.5 pr-3">
                      <Link href={adminAgentHref(a.agentId)} className="hover:underline">
                        {a.name}
                      </Link>
                      {a.cloud && <span className="ml-1.5 text-xs text-[var(--muted)]">cloud</span>}
                    </td>
                    <td className="py-1.5 pr-3">{a.owner}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{tokens(a.input)}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{tokens(a.output)}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{a.calls}</td>
                    <td className="py-1.5 text-right tabular-nums">${(a.micros / 1e6).toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Endpoints the hub can't sign in to</h2>
          {o.endpointProblems.length === 0 ? (
            <Empty>Every A2A endpoint accepts its credential.</Empty>
          ) : (
            <ul className="list">
              {o.endpointProblems.map((a) => (
                <li key={a.id}>
                  <Link href={adminAgentHref(a.id)} className="flex items-start gap-3 px-4 py-3 hover:bg-[var(--subtle)]">
                    <Avatar who={a} className="size-8" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{a.name}</span>
                      <span className="block text-sm break-words text-[var(--bad-fg)]">{a.authProblem}</span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
      </section>

      <p className="text-xs text-[var(--muted)]">Generated {ago(o.generatedAt)} ({o.generatedAt}). Reload for fresh numbers.</p>
    </div>
  );
}
