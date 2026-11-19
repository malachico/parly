/**
 * How the hub authenticates to an A2A agent's server. The hub checks the choice against the agent's
 * card and says what the card asks for if it doesn't fit. Radios + :has() show only the chosen
 * type's fields, without client code. `keep` (changing an existing connection) adds "Keep the current one".
 */
export function AuthFields({ keep = false }: { keep?: boolean }) {
  const kinds = [
    ...(keep ? ([['keep', 'Keep the current one']] as const) : []),
    ['none', 'None'],
    ['bearer', 'Bearer token'],
    ['apiKey', 'API key header'],
    ['basic', 'Username + password'],
    ['oauth2', 'OAuth2 client credentials'],
  ] as const;
  const show = (k: string) =>
    ({
      bearer: 'group-has-[#auth-bearer:checked]:flex',
      apiKey: 'group-has-[#auth-apiKey:checked]:flex',
      basic: 'group-has-[#auth-basic:checked]:flex',
      oauth2: 'group-has-[#auth-oauth2:checked]:flex',
    })[k];
  return (
    <fieldset className="group space-y-2">
      <legend className="label">How the hub signs in to it</legend>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
        {kinds.map(([k, label]) => (
          <label key={k} className="flex items-center gap-1.5">
            <input type="radio" id={`auth-${k}`} name="authType" value={k} defaultChecked={k === (keep ? 'keep' : 'none')} />
            {label}
          </label>
        ))}
      </div>
      <div className={`hidden flex-col gap-2 ${show('bearer')}`}>
        <input name="bearerToken" type="password" className="input" autoComplete="off" aria-label="Bearer token" placeholder="Token, sent as Authorization: Bearer …" />
      </div>
      <div className={`hidden flex-col gap-2 ${show('apiKey')}`}>
        <input name="apiKeyHeader" className="input" autoComplete="off" aria-label="Header name" placeholder="Header name, e.g. X-API-Key (optional if its card names it)" />
        <input name="apiKeyValue" type="password" className="input" autoComplete="off" aria-label="API key" placeholder="API key" />
      </div>
      <div className={`hidden flex-col gap-2 ${show('basic')}`}>
        <input name="basicUser" className="input" autoComplete="off" aria-label="Username" placeholder="Username" />
        <input name="basicPassword" type="password" className="input" autoComplete="off" aria-label="Password" placeholder="Password" />
      </div>
      <div className={`hidden flex-col gap-2 ${show('oauth2')}`}>
        <input name="oauthClientId" className="input" autoComplete="off" aria-label="Client ID" placeholder="Client ID" />
        <input name="oauthClientSecret" type="password" className="input" autoComplete="off" aria-label="Client secret" placeholder="Client secret" />
        <input name="oauthScopes" className="input" autoComplete="off" aria-label="Scopes" placeholder="Scopes you grant, space-separated (optional)" />
        <p className="muted text-[13px]">The token URL comes from the agent&apos;s card.</p>
      </div>
      <p className="muted text-[13px]">Most A2A servers want one. Never shown again; the hub sends it only to this URL, and calls it once right away to check it works.</p>
    </fieldset>
  );
}
