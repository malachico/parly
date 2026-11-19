import { describe, expect, it } from 'vitest';
import { credentialProblem, describeScheme, parseCardAuth, supportedOptions } from '../src/hub/agentAuth.js';

describe('agent card auth', () => {
  it('reads A2A 1.0 schemes and requirements, keeping alternatives and combinations', () => {
    const auth = parseCardAuth({
      securitySchemes: {
        token: { httpAuthSecurityScheme: { scheme: 'Bearer' } },
        key: { apiKeySecurityScheme: { location: 'header', name: 'X-API-Key' } },
        cc: { oauth2SecurityScheme: { flows: { clientCredentials: { tokenUrl: 'https://auth.example.com/token', scopes: { 'tasks:write': '' } } } } },
      },
      // token, OR (key AND cc).
      securityRequirements: [{ schemes: { token: { list: [] } } }, { schemes: { key: { list: [] }, cc: { list: ['tasks:write'] } } }],
    });
    expect(auth?.options.map((o) => o.schemes.map((s) => s.type))).toEqual([['bearer'], ['apiKey', 'oauth2']]);
    // Only single-scheme alternatives are supported; the combination is not silently reduced to one part.
    expect(supportedOptions(auth).map((s) => s.type)).toEqual(['bearer']);
  });

  it('reads the 0.3 format, and marks what the hub cannot send as unsupported', () => {
    const auth = parseCardAuth({
      securitySchemes: {
        b: { type: 'http', scheme: 'basic' },
        q: { type: 'apiKey', in: 'query', name: 'key' },
        oidc: { type: 'openIdConnect', openIdConnectUrl: 'https://x' },
      },
      security: [{ b: [] }, { q: [] }, { oidc: [] }],
    });
    expect(auth?.options.map((o) => o.schemes[0]!.type)).toEqual(['basic', 'unsupported', 'unsupported']);
    expect(describeScheme(auth!.options[1]!.schemes[0]!)).toMatch(/query.*not supported/);
    expect(supportedOptions(auth).map((s) => s.type)).toEqual(['basic']);
  });

  it('is undefined for a card that declares nothing; declared schemes without requirements are each an option', () => {
    expect(parseCardAuth({ name: 'echo' })).toBeUndefined();
    expect(parseCardAuth({ securitySchemes: { t: { httpAuthSecurityScheme: { scheme: 'bearer' } } } })?.options).toEqual([{ schemes: [{ id: 't', type: 'bearer' }] }]);
  });

  it('freezes a credential whose scheme the card no longer asks for', () => {
    const bearer = parseCardAuth({ securitySchemes: { t: { httpAuthSecurityScheme: { scheme: 'bearer' } } } });
    const key = { type: 'apiKey', header: 'X-API-Key', value: 'v', for: 'apiKey:x-api-key' } as const;
    expect(credentialProblem(key, bearer)).toMatch(/now asks for a bearer token/);
    expect(credentialProblem({ for: 'bearer' }, bearer)).toBeUndefined();
    // A card that declares nothing doesn't freeze anything; nor does an agent with no credential.
    expect(credentialProblem(key, undefined)).toBeUndefined();
    expect(credentialProblem(undefined, bearer)).toBeUndefined();
  });
});
