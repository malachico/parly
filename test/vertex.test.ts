import { beforeEach, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({
  getAccessToken: vi.fn(async () => 'adc-token'),
  getProjectId: vi.fn(async () => 'adc-project'),
  construct: vi.fn(),
}));
vi.mock('google-auth-library', () => ({
  GoogleAuth: class {
    constructor() { auth.construct(); }
    getAccessToken = auth.getAccessToken;
    getProjectId = auth.getProjectId;
  },
}));
beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); });

it('reuses ADC credentials across generated requests and coalesces project discovery', async () => {
  const { generate, vertexAccessToken, vertexProject } = await import('../src/lib/vertex.js');
  const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer adc-token');
    return new Response('{}');
  });
  await generate({ project: 'p', location: 'global', model: 'm', prompt: 'one', fetchImpl });
  await generate({ project: 'p', location: 'global', model: 'm', prompt: 'two', fetchImpl });
  expect(await Promise.all([vertexProject(), vertexProject()])).toEqual(['adc-project', 'adc-project']);
  expect(await vertexProject()).toBe('adc-project');
  expect(auth.construct).toHaveBeenCalledTimes(1);
  expect(auth.getProjectId).toHaveBeenCalledTimes(1);
  expect(auth.getAccessToken).toHaveBeenCalledTimes(2); // GoogleAuth manages token expiry
  const override = vi.fn(async () => 'override');
  expect(vertexAccessToken(override)).toBe(override);
  expect(await vertexProject('configured')).toBe('configured');
  expect(auth.getProjectId).toHaveBeenCalledTimes(1);
});

it('retries project discovery after a transient ADC failure', async () => {
  auth.getProjectId.mockRejectedValueOnce(new Error('metadata unavailable'));
  const { vertexProject } = await import('../src/lib/vertex.js');
  await expect(vertexProject()).rejects.toThrow('metadata unavailable');
  expect(await vertexProject()).toBe('adc-project');
});
