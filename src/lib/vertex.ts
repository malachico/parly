import { GoogleAuth } from 'google-auth-library';
import type { LlmUsage } from './llmCost.js';

const google = new GoogleAuth({ scopes: 'https://www.googleapis.com/auth/cloud-platform' });
let projectId: Promise<string> | undefined;

/** Vertex regional (or global) API root for a project. */
export function vertexBase(opts: { project: string; location: string }): string {
  const host = opts.location === 'global' ? 'aiplatform.googleapis.com' : `${opts.location}-aiplatform.googleapis.com`;
  return `https://${host}/v1/projects/${opts.project}/locations/${opts.location}`;
}

/** `:generateContent` URL for a publisher model. */
export function vertexGenerateUrl(opts: { project: string; location: string; model: string }): string {
  return `${vertexBase(opts)}/publishers/google/models/${opts.model}:generateContent`;
}

/** Hub service-account token, or a test stand-in. */
export function vertexAccessToken(accessToken?: () => Promise<string>): () => Promise<string> {
  if (accessToken) return accessToken;
  return async () => (await google.getAccessToken())!;
}

/** Configured project, else the one the hub's credentials belong to. */
export async function vertexProject(project?: string): Promise<string> {
  if (project) return project;
  return projectId ??= google.getProjectId().catch((error) => {
    projectId = undefined;
    throw error;
  });
}

type VertexGenerateOpts = {
  project: string;
  location: string;
  model: string;
  prompt: string;
  /** Vertex `responseSchema` (implies `responseMimeType: application/json`). */
  schema?: Record<string, unknown>;
  timeoutMs?: number;
  accessToken?: () => Promise<string>;
  fetchImpl?: typeof fetch;
  thinkingLevel?: 'low' | 'medium' | 'high';
  tools?: unknown[];
};

type VertexGenerateBody = {
  candidates?: {
    content?: { parts?: { text?: string; thought?: boolean }[] };
    groundingMetadata?: { groundingChunks?: { web?: { uri?: string; title?: string } }[] };
  }[];
  usageMetadata?: LlmUsage;
};

type VertexGenerateResult = {
  ok: boolean;
  status: number;
  /** Non-thought text parts joined (empty when the call failed or returned none). */
  text: string;
  usage?: LlmUsage;
  body: VertexGenerateBody;
  /** Upstream error body when `!ok` (callers that log it). */
  errorText?: string;
};

/**
 * One-shot Vertex `generateContent`: a single user prompt, optional JSON schema / tools / thinking level.
 * Does not throw on HTTP errors — check `ok` / `status`. Network and abort errors still reject.
 */
export async function generate(opts: VertexGenerateOpts): Promise<VertexGenerateResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const token = vertexAccessToken(opts.accessToken);
  const generationConfig: Record<string, unknown> = {};
  if (opts.thinkingLevel) generationConfig.thinkingConfig = { thinkingLevel: opts.thinkingLevel };
  if (opts.schema) {
    generationConfig.responseMimeType = 'application/json';
    generationConfig.responseSchema = opts.schema;
  }
  const res = await fetchImpl(vertexGenerateUrl(opts), {
    method: 'POST',
    headers: { authorization: `Bearer ${await token()}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: opts.prompt }] }],
      ...(Object.keys(generationConfig).length ? { generationConfig } : {}),
      ...(opts.tools?.length ? { tools: opts.tools } : {}),
    }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
  });
  if (!res.ok) {
    return { ok: false, status: res.status, text: '', body: {}, errorText: await res.text().catch(() => '') };
  }
  const body = (await res.json().catch(() => ({}))) as VertexGenerateBody;
  const parts = body.candidates?.[0]?.content?.parts ?? [];
  const text = parts.filter((p) => !p.thought && typeof p.text === 'string').map((p) => p.text!).join('');
  return { ok: true, status: res.status, text, usage: body.usageMetadata, body };
}

type VertexEmbedOpts = {
  project: string;
  location: string;
  model: string;
  text: string;
  /** How the vector will be used: a search query, or a stored document to be found. */
  taskType: 'RETRIEVAL_QUERY' | 'RETRIEVAL_DOCUMENT';
  /** Truncate to this many dimensions (the index must agree). */
  dimensions?: number;
  timeoutMs?: number;
  accessToken?: () => Promise<string>;
  fetchImpl?: typeof fetch;
};

type VertexEmbedResult = {
  ok: boolean;
  status: number;
  /** Empty when the call failed. */
  vector: number[];
  /** Input tokens billed (estimated from length when Vertex doesn't say). */
  tokens: number;
  errorText?: string;
};

/**
 * One text through Vertex `:predict` on an embedding model (gemini-embedding-001 takes one instance per request).
 * Does not throw on HTTP errors — check `ok`. Network and abort errors still reject.
 */
export async function embed(opts: VertexEmbedOpts): Promise<VertexEmbedResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const token = vertexAccessToken(opts.accessToken);
  const res = await fetchImpl(`${vertexBase(opts)}/publishers/google/models/${opts.model}:predict`, {
    method: 'POST',
    headers: { authorization: `Bearer ${await token()}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      instances: [{ content: opts.text, task_type: opts.taskType }],
      ...(opts.dimensions ? { parameters: { outputDimensionality: opts.dimensions } } : {}),
    }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
  });
  // Billed whether or not the body parses; ~4 characters a token when Vertex reports none.
  const estimate = Math.ceil(opts.text.length / 4);
  if (!res.ok) return { ok: false, status: res.status, vector: [], tokens: 0, errorText: await res.text().catch(() => '') };
  const body = (await res.json().catch(() => ({}))) as { predictions?: { embeddings?: { values?: number[]; statistics?: { token_count?: number } } }[] };
  const embeddings = body.predictions?.[0]?.embeddings;
  const vector = embeddings?.values ?? [];
  return { ok: vector.length > 0, status: res.status, vector, tokens: embeddings?.statistics?.token_count ?? estimate };
}
