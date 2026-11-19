import { GoogleAuth } from 'google-auth-library';
import type { ComputerDriver, ComputerState, RunSpec } from './computers.js';

/**
 * Runs hosted agents on GKE Agent Sandbox: each agent is its own clean gVisor pod (a SandboxClaim), made when it has
 * mail and deleted when its computer goes quiet. Its keys are in a Secret; its files are a tarball in its own folder
 * of a shared bucket, which the pod restores on start and saves as it works. The pod reads its own mail
 * (wait_for_message), so the hub only creates and deletes it.
 *
 * Each agent has its own Kubernetes service account, and only that account can touch its folder: the pod can reach
 * the metadata server (for that account's token), so a shared account would let one agent read every agent's files.
 */
interface GkeOptions {
  /** The cluster's DNS endpoint (gke-….gke.goog), which takes a Google access token. */
  endpoint: string;
  namespace: string;
  image: string;
  /** The bucket of agents' files (a folder `agents/<id>/` each). */
  homesBucket: string;
  /** The cluster's workload identity pool: `projects/<number>/locations/global/workloadIdentityPools/<project>.svc.id.goog`. */
  identityPool: string;
  /** A Google access token for the APIs (the hub's service account by default). */
  token?: () => Promise<string>;
  fetchImpl?: typeof fetch;
}

const AGENT = 'parly.dev/agent';
const OWNER = 'parly.dev/owner';
const SANDBOX = 'extensions.agents.x-k8s.io/v1alpha1';
const GCS = 'https://storage.googleapis.com/storage/v1';

export class GkeDriver implements ComputerDriver {
  /** Tells the hub a computer's new state (set by the app). */
  report: (computerId: string, state: ComputerState) => Promise<void> = async () => {};
  private readonly token: () => Promise<string>;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: GkeOptions) {
    const google = new GoogleAuth({ scopes: 'https://www.googleapis.com/auth/cloud-platform' });
    this.token = opts.token ?? (async () => (await google.getAccessToken())!);
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async call(method: string, url: string, body?: unknown, ok: number[] = []): Promise<{ status: number } & Record<string, unknown>> {
    const res = await this.fetchImpl(url, {
      method,
      // A PATCH merges into what's there (JSON merge patch).
      headers: { authorization: `Bearer ${await this.token()}`, 'content-type': method === 'PATCH' ? 'application/merge-patch+json' : 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok && !ok.includes(res.status)) throw new Error(`${method} ${url}: HTTP ${res.status} ${await res.text().catch(() => '')}`);
    return { ...((await res.json().catch(() => ({}))) as object), status: res.status };
  }

  private k8s(group: string, kind: string, name = ''): string {
    const base = group === '' ? '/api/v1' : `/apis/${group}`;
    return `https://${this.opts.endpoint}${base}/namespaces/${this.opts.namespace}/${kind}${name ? `/${name}` : ''}`;
  }

  /** Creates it unless it's there already. */
  private create(group: string, kind: string, obj: object): Promise<unknown> {
    return this.call('POST', this.k8s(group, kind), obj, [409]);
  }

  /** Creates it, or brings the one there up to date (a new image, a rotated token): the agent's next pod gets it. */
  private async put(group: string, kind: string, obj: { metadata: { name: string }; [k: string]: unknown }): Promise<void> {
    if ((await this.call('POST', this.k8s(group, kind), obj, [409])).status === 409) await this.call('PATCH', this.k8s(group, kind, obj.metadata.name), obj);
  }

  // Agents have their own pods, so the computer itself is ready at once; its agents start in runAgent.
  async start(computerId: string): Promise<void> {
    setImmediate(() => void this.report(computerId, 'ready').catch((err) => console.error(`computer ${computerId} ready`, err)));
  }

  async runAgent(computerId: string, spec: RunSpec): Promise<void> {
    const name = `a-${spec.agentId}`;
    const labels = { [AGENT]: spec.agentId, [OWNER]: computerId };
    const metadata = { name, namespace: this.opts.namespace, labels };
    const folder = `agents/${spec.agentId}/`;
    // An agent's first run makes its folder and identity, the account last: until it exists, the next run retries.
    if ((await this.call('GET', this.k8s('', 'serviceaccounts', name), undefined, [404])).status === 404) {
      await this.call('POST', `${GCS}/b/${this.opts.homesBucket}/managedFolders`, { name: folder }, [409]);
      const member = `principal://iam.googleapis.com/${this.opts.identityPool}/subject/ns/${this.opts.namespace}/sa/${name}`;
      await this.call('PUT', `${GCS}/b/${this.opts.homesBucket}/managedFolders/${encodeURIComponent(folder)}/iam`, {
        bindings: [{ role: 'roles/storage.objectUser', members: [member] }],
      });
      await this.create('', 'serviceaccounts', { apiVersion: 'v1', kind: 'ServiceAccount', metadata });
    }
    await this.put('', 'secrets', {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata,
      stringData: {
        PARLY_AGENT_ID: spec.agentId,
        PARLY_AGENT_NAME: spec.agentName,
        PARLY_AGENT_TOKEN: spec.agentToken,
        PARLY_HUB_URL: spec.hubUrl,
        PARLY_LLM_BASE_URL: spec.llmBaseUrl,
        PARLY_LLM_KEY: spec.llmKey,
        PARLY_HOMES_BUCKET: this.opts.homesBucket,
      },
    });
    await this.put(SANDBOX, 'sandboxtemplates', {
      apiVersion: SANDBOX,
      kind: 'SandboxTemplate',
      metadata,
      spec: {
        // The internet, and the metadata server for this agent's own token; not the cluster or the VPC.
        networkPolicy: {
          egress: [
            { to: [{ ipBlock: { cidr: '0.0.0.0/0', except: ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16'] } }] },
            { to: [{ ipBlock: { cidr: '169.254.169.254/32' } }, { ipBlock: { cidr: '169.254.169.252/32' } }] },
          ],
        },
        podTemplate: {
          // safe-to-evict:false keeps the GKE Autopilot autoscaler from reclaiming the node mid-run and
          // killing the agent (it otherwise scales these down on a ~1-3h cost-consolidation cycle, so the
          // agent loses its session and goes quiet). Reliability over bin-packing: we want these to stay up.
          metadata: { labels, annotations: { 'cluster-autoscaler.kubernetes.io/safe-to-evict': 'false' } },
          spec: {
            serviceAccountName: name,
            runtimeClassName: 'gvisor',
            // Time for the last save of its files: a large home takes minutes to pack and upload.
            terminationGracePeriodSeconds: 300,
            automountServiceAccountToken: false,
            nodeSelector: { 'cloud.google.com/compute-class': 'parly-sandbox' },
            // The cluster's DNS is on a private address the policy blocks.
            dnsPolicy: 'None',
            dnsConfig: { nameservers: ['8.8.8.8', '1.1.1.1'] },
            containers: [
              {
                name: 'agent',
                image: this.opts.image,
                envFrom: [{ secretRef: { name } }],
                resources: { requests: { cpu: '1', memory: '2Gi', 'ephemeral-storage': '4Gi' }, limits: { cpu: '2', memory: '4Gi' } },
                securityContext: { runAsNonRoot: true, runAsUser: 1000, allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] } },
              },
            ],
          },
        },
      },
    });
    // Running already: it reads its own mail. Otherwise this starts it.
    await this.create(SANDBOX, 'sandboxclaims', { apiVersion: SANDBOX, kind: 'SandboxClaim', metadata, spec: { sandboxTemplateRef: { name } } });
  }

  /** Deletes the computer's agent pods: each saves its files before it goes. */
  async stop(computerId: string): Promise<void> {
    const claims = await this.call('GET', `${this.k8s(SANDBOX, 'sandboxclaims')}?labelSelector=${encodeURIComponent(`${OWNER}=${computerId}`)}`);
    const items = Array.isArray(claims.items) ? (claims.items as { metadata?: { name?: string } }[]) : [];
    for (const claim of items) {
      if (!claim.metadata?.name) continue;
      await this.call('DELETE', this.k8s(SANDBOX, 'sandboxclaims', claim.metadata.name), undefined, [404]);
    }
    await this.report(computerId, 'stopped');
  }
}
