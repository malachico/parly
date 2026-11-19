import { describe, expect, it } from 'vitest';
import { GkeDriver } from '../src/computers/gkeDriver.js';
import type { RunSpec } from '../src/computers/computers.js';

const spec = (agentId: string): RunSpec => ({
  agentId,
  agentName: 'Igor',
  agentToken: `tok_${agentId}`,
  hubUrl: 'https://hub',
  llmBaseUrl: 'https://hub/llm/vertex',
  llmKey: `plk_${agentId}`,
});

const POOL = 'projects/1/locations/global/workloadIdentityPools/p.svc.id.goog';
const NS = 'https://gke.test/api/v1/namespaces/parly';
const SB = 'https://gke.test/apis/extensions.agents.x-k8s.io/v1alpha1/namespaces/parly';
const GCS = 'https://storage.googleapis.com/storage/v1/b/homes';

/** A fake Kubernetes + Cloud Storage API: keeps what's created (by URL), 409 on a second create, 404 when missing. */
function fakeCloud() {
  const objects = new Map<string, any>();
  const calls: string[] = [];
  const fetchImpl = (async (input: string, init: RequestInit) => {
    const url = new URL(input);
    const at = `${url.origin}${url.pathname}`;
    const method = init.method!;
    calls.push(`${method} ${at}`);
    const json = (status: number, body: unknown = {}) => new Response(JSON.stringify(body), { status });
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    if (method === 'POST') {
      const key = `${at}/${body.metadata?.name ?? encodeURIComponent(body.name)}`;
      if (objects.has(key)) return json(409);
      objects.set(key, body);
      return json(201, body);
    }
    if (method === 'PUT') return json(200, objects.set(at, body) && body);
    if (method === 'PATCH') return objects.has(at) ? json(200, objects.set(at, { ...objects.get(at), ...body }).get(at)) : json(404);
    if (method === 'DELETE') return json(objects.delete(at) ? 200 : 404);
    if (objects.has(at)) return json(200, objects.get(at));
    const items = [...objects.entries()].filter(([k]) => k.startsWith(`${at}/`)).map(([, v]) => v);
    const [lk, lv] = url.searchParams.get('labelSelector')?.split('=') ?? [];
    // Kubernetes answers a miss with a Status object, whose own `status` is 'Failure'.
    return lk ? json(200, { items: items.filter((o) => o.metadata.labels?.[lk] === lv) }) : json(404, { kind: 'Status', status: 'Failure' });
  }) as typeof fetch;
  const driver = new GkeDriver({ endpoint: 'gke.test', namespace: 'parly', image: 'img:1', homesBucket: 'homes', identityPool: POOL, token: async () => 't', fetchImpl });
  return { driver, objects, calls };
}

describe('GKE Agent Sandbox driver', () => {
  it('gives each agent its own pod, keys, and identity that alone can reach its folder of files', async () => {
    const { driver, objects, calls } = fakeCloud();
    await driver.runAgent('owner1', spec('ag1'));
    await driver.runAgent('owner1', spec('ag2'));
    const before = calls.length;
    await driver.runAgent('owner1', spec('ag1')); // more mail for a known agent: no new identity or folder rights
    expect(calls.slice(before).filter((c) => c.includes('storage.googleapis.com'))).toEqual([]);

    for (const id of ['ag1', 'ag2']) {
      const folder = encodeURIComponent(`agents/${id}/`);
      expect(objects.has(`${GCS}/managedFolders/${folder}`)).toBe(true);
      expect(objects.get(`${GCS}/managedFolders/${folder}/iam`).bindings).toEqual([
        { role: 'roles/storage.objectUser', members: [`principal://iam.googleapis.com/${POOL}/subject/ns/parly/sa/a-${id}`] },
      ]);
      expect(objects.has(`${NS}/serviceaccounts/a-${id}`)).toBe(true);
      const pod = objects.get(`${SB}/sandboxtemplates/a-${id}`).spec.podTemplate.spec;
      expect(pod).toMatchObject({ serviceAccountName: `a-${id}`, runtimeClassName: 'gvisor', automountServiceAccountToken: false });
      expect(pod.containers[0].envFrom).toEqual([{ secretRef: { name: `a-${id}` } }]);
      expect(objects.get(`${NS}/secrets/a-${id}`).stringData).toMatchObject({ PARLY_AGENT_TOKEN: `tok_${id}`, PARLY_LLM_KEY: `plk_${id}`, PARLY_HOMES_BUCKET: 'homes' });
      expect(objects.get(`${SB}/sandboxclaims/a-${id}`).metadata.labels['parly.dev/owner']).toBe('owner1');
    }
    // No private networks from the pod; the keys are in the Secret only.
    const egress = objects.get(`${SB}/sandboxtemplates/a-ag1`).spec.networkPolicy.egress;
    expect(egress[0].to[0].ipBlock.except).toEqual(expect.arrayContaining(['10.0.0.0/8', '169.254.0.0/16']));
    expect(JSON.stringify([...objects.values()].filter((o) => o.kind !== 'Secret'))).not.toContain('tok_ag1');
  });

  it("gives a known agent's next pod the current image and keys", async () => {
    const { driver, objects } = fakeCloud();
    await driver.runAgent('owner1', spec('ag1'));
    (driver as any).opts.image = 'img:2';
    await driver.runAgent('owner1', { ...spec('ag1'), agentToken: 'tok_rotated' });
    expect(objects.get(`${SB}/sandboxtemplates/a-ag1`).spec.podTemplate.spec.containers[0].image).toBe('img:2');
    expect(objects.get(`${NS}/secrets/a-ag1`).stringData.PARLY_AGENT_TOKEN).toBe('tok_rotated');
  });

  it('retries the folder rights when they failed on the first run', async () => {
    const { driver, objects } = fakeCloud();
    let failIam = true;
    const real = (driver as any).fetchImpl as typeof fetch;
    (driver as any).fetchImpl = (async (url: string, init: RequestInit) =>
      failIam && init.method === 'PUT' ? new Response('{}', { status: 503 }) : real(url, init)) as typeof fetch;
    await expect(driver.runAgent('owner1', spec('ag1'))).rejects.toThrow(/503/);
    failIam = false;
    await driver.runAgent('owner1', spec('ag1'));
    expect(objects.get(`${GCS}/managedFolders/${encodeURIComponent('agents/ag1/')}/iam`)).toBeDefined();
  });

  it('stops a computer by deleting its agents\' pods, and only its own', async () => {
    const { driver, objects } = fakeCloud();
    const states: string[] = [];
    driver.report = async (id, state) => void states.push(`${id} ${state}`);
    await driver.runAgent('owner1', spec('ag1'));
    await driver.runAgent('owner2', spec('other'));
    await driver.stop('owner1');
    expect(objects.has(`${SB}/sandboxclaims/a-ag1`)).toBe(false);
    expect(objects.has(`${SB}/sandboxclaims/a-other`)).toBe(true);
    expect(states).toEqual(['owner1 stopped']);
  });
});
