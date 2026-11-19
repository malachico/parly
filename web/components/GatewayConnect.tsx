'use client';
import { PendingButton } from './PendingButton';

import { useState } from 'react';
import { CopyButton } from '@/components/CopyButton';
import { Step } from '@/components/Step';
import { createConnection } from '@/lib/actions';
import { caddyCommands, hermesSetupCommands, openclawSetupCommands } from '@/lib/connect';

const GATEWAYS = {
  openclaw: {
    label: 'OpenClaw',
    address: "Its gateway's address",
    hint: 'Its public HTTPS address: the hub must reach /.well-known/agent-card.json and /a2a/v1 there (behind a reverse proxy is fine).',
    placeholder: 'https://your-gateway.example.com',
    turnOn: 'Turn on its A2A channel',
    commands: openclawSetupCommands,
  },
  hermes: {
    label: 'Hermes',
    address: 'Its public address',
    hint: 'Hermes listens on 127.0.0.1:9900 only, so put an HTTPS reverse proxy in front: the hub must reach /.well-known/agent-card.json and / there.',
    placeholder: 'https://your-hermes.example.com',
    turnOn: 'Turn on its A2A server',
    commands: hermesSetupCommands,
  },
} as const;

/**
 * Connect page, an agent gateway the hub calls over A2A (OpenClaw, Hermes): its address first, so the setup
 * commands carry it; then the token those commands print. One form, so the address typed in step 1 is the one
 * connected. The commands turn on its A2A side with a peer for the hub (the token the hub calls it with); its
 * own hub token comes afterwards (EndpointReady).
 */
export function GatewayConnect({ client, defaultName }: { client: keyof typeof GATEWAYS; defaultName: string }) {
  const g = GATEWAYS[client];
  const [url, setUrl] = useState('');
  const address = url.trim().replace(/\/+$/, '');
  const commands = g.commands(address || undefined);
  const caddy = caddyCommands(client);
  return (
    <form action={createConnection} className="card space-y-5 border-[var(--accent)]">
      <input type="hidden" name="client" value={client} />
      <input type="hidden" name="authType" value="bearer" />
      <Step n={1} title={g.address} hint={g.hint}>
        <input name="url" type="url" className="input" placeholder={g.placeholder} value={url} onChange={(e) => setUrl(e.target.value)} aria-label={g.address} required />
        <details className="mt-2 rounded-lg border border-[var(--border)] px-3 py-2">
          <summary className="cursor-pointer text-sm font-medium">No HTTPS address yet?</summary>
          <div className="mt-2 space-y-2">
            <p className="muted text-[13px]">
              On the {g.label} machine (Debian or Ubuntu): Caddy in front of it, on a free name for its public IP with a certificate, exposing only what the hub needs.
              Open ports 80 and 443 to the machine in your cloud&apos;s firewall, and keep its IP fixed (the name is the IP). Paste the address it prints above.
            </p>
            <div className="flex items-start gap-2">
              <pre className="code min-w-0 flex-1 overflow-x-auto break-normal whitespace-pre">{caddy}</pre>
              <CopyButton value={caddy} label="Copy" />
            </div>
          </div>
        </details>
      </Step>
      <Step n={2} title={g.turnOn} hint={`On the ${g.label} machine, in one shell session. The last line prints the token the hub will call it with.`}>
        <div className="flex items-start gap-2">
          <pre className="code min-w-0 flex-1 overflow-x-auto break-normal whitespace-pre">{commands}</pre>
          <CopyButton value={commands} label="Copy" />
        </div>
      </Step>
      <Step n={3} title="Connect it">
        <label htmlFor="connect-token" className="label">
          The token from step 2
        </label>
        <input id="connect-token" name="bearerToken" type="password" className="input" autoComplete="off" required />
        <label htmlFor="connect-name" className="label">
          Name on the hub
        </label>
        <input id="connect-name" name="name" className="input" defaultValue={defaultName} maxLength={64} required />
        <p className="muted text-[13px]">The token is never shown again. The hub sends it only to this address, and calls it once right away to check it works.</p>
        <PendingButton className="btn-primary w-full sm:w-auto">Connect {g.label}</PendingButton>
      </Step>
    </form>
  );
}
