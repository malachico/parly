import { createHmac, timingSafeEqual } from 'node:crypto';
import { HubError } from '../lib/errors.js';

/**
 * Tools for cloud agents through Composio: any of its apps (GitHub, Gmail, Jira, HubSpot, ...). A person connects
 * their own accounts (Composio's hosted sign-in, as Composio user = their Parly id); their cloud agents then find
 * and run tools as them, on demand. The API key stays on the hub: agents never see it, and every call is made for
 * the agent's owner only.
 */
/** Composio's API (COMPOSIO_API_URL overrides it, for a stand-in when testing). */
const API = process.env.COMPOSIO_API_URL || 'https://backend.composio.dev/api/v3.1';

/** Shown first in the Tools section, before searching the whole catalog. */
export const POPULAR: Record<string, string> = {
  gmail: 'Gmail',
  googlecalendar: 'Google Calendar',
  googledrive: 'Google Drive',
  notion: 'Notion',
  linear: 'Linear',
  slack: 'Slack',
  jira: 'Jira',
  hubspot: 'HubSpot',
  googlesheets: 'Google Sheets',
  outlook: 'Outlook',
  airtable: 'Airtable',
};

const GITHUB_APP_SLUG = 'parly-dev';
/** Where a person installs Parly's GitHub App instead of going through Composio OAuth. */
export const githubInstallUrl = (slug = GITHUB_APP_SLUG) => `https://github.com/apps/${encodeURIComponent(slug)}/installations/new`;

/** One of Composio's apps, as the Tools section lists it. */
interface Toolkit {
  slug: string;
  name: string;
  logo?: string;
  description?: string;
  tools: number;
  /** Connectable from Parly: Composio signs people in to it (OAuth it manages), it needs no sign-in, or its key is entered on Composio's own page. */
  connectable: boolean;
  /** Connected with the person's own key (API key, token, login), typed on Composio's page, never in Parly. */
  keyed?: boolean;
}

/** The ways of signing in that a person completes on Composio's hosted page with their own credentials. */
const KEY_SCHEMES = ['API_KEY', 'BEARER_TOKEN', 'BASIC', 'BASIC_WITH_JWT'];

/** One of a person's connected accounts. */
interface ToolAccount {
  authConfigId?: string;
  id: string;
  toolkit: string;
  status: string;
}

/** A tool as an agent finds it: what it does, its arguments (JSON Schema), and whether it only reads. */
interface ToolSpec {
  slug: string;
  toolkit: string;
  description: string;
  parameters: Record<string, unknown>;
  readOnly: boolean;
}

const CATALOG_TTL_MS = 60 * 60_000;
/** Apps loaded at a time, for the catalog and for each search. */
const CATALOG_SIZE = 20;

type RawToolkit = { slug: string; name: string; no_auth?: boolean; composio_managed_auth_schemes?: string[]; auth_schemes?: string[]; meta?: { logo?: string; description?: string; tools_count?: number } };
const SCHEMA_TTL_MS = 10 * 60_000;
/** Words that say nothing about which tool ("list my open issues" → list, open, issues). */
const STOP = new Set(['a', 'an', 'the', 'my', 'me', 'to', 'of', 'in', 'on', 'for', 'and', 'or', 'with', 'all', 'some', 'please', 'from', 'by', 'it', 'is', 'what', 'which']);

/**
 * Whether a tool only reads: Composio's MCP hints when it has them, else its name (…_GET_…, …_LIST_…). Unknown counts
 * as a write, which an agent only gets when its owner lets it act.
 */
function isReadOnly(t: { slug: string; tags?: string[] }): boolean {
  if (t.tags?.some((h) => h === 'destructiveHint' || h === 'createHint' || h === 'updateHint')) return false;
  if (t.tags?.includes('readOnlyHint')) return true;
  return /_(GET|LIST|FETCH|SEARCH|FIND|READ|RETRIEVE|DESCRIBE)(_|$)/.test(t.slug);
}

/** The app a tool belongs to, from its slug (GITHUB_LIST_ISSUES → github), among the given ones. */
export const toolkitOf = (slug: string, toolkits: string[]) => toolkits.find((t) => slug.toLowerCase().startsWith(`${t.toLowerCase()}_`));

type RawTool = { slug: string; description?: string; input_parameters?: Record<string, unknown>; tags?: string[] };

export class Composio {
  private readonly fetchImpl: typeof fetch;
  private readonly authConfigs = new Map<string, string>();
  private authConfigsCheckedAt = 0;
  private catalogCache?: { at: number; list: Toolkit[] };
  private readonly seen = new Map<string, Toolkit>();
  private readonly toolCache = new Map<string, { at: number; tool: ToolSpec }>();
  private readonly indexCache = new Map<string, { at: number; list: { slug: string; text: string; readOnly: boolean; important: boolean }[] }>();
  private readonly triggerCache = new Map<string, { at: number; list: TriggerType[] }>();

  constructor(
    private readonly apiKey: string,
    fetchImpl?: typeof fetch,
    private readonly githubAppSlug = GITHUB_APP_SLUG,
  ) {
    this.fetchImpl = fetchImpl ?? fetch;
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${API}${path}`, {
      method,
      headers: { 'x-api-key': this.apiKey, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await res.text();
    // Don't forward upstream bodies to agents (may contain tokens or internal detail); keep the body as internal `detail` for catch-site decisions.
    if (!res.ok) throw new HubError('unavailable', `Composio answered HTTP ${res.status}`, text.slice(0, 300));
    return (text ? JSON.parse(text) : {}) as T;
  }

  /** Pulls configured `/auth_configs` from Composio and records their toolkit -> auth_config_id mapping. */
  private async syncConfiguredToolkits(): Promise<Set<string>> {
    this.authConfigsCheckedAt = Date.now();
    const configs = await this.call<{ items?: { id?: string; status?: string; toolkit?: { slug?: string } }[] }>('GET', '/auth_configs?limit=1000').catch(() => ({ items: [] }));
    const configured = new Set<string>();
    for (const c of configs.items ?? []) {
      const slug = c.toolkit?.slug;
      if (slug && c.id && c.status !== 'DISABLED') {
        configured.add(slug);
        this.authConfigs.set(slug, c.id);
      }
    }
    for (const t of this.seen.values()) {
      if (configured.has(t.slug)) t.connectable = true;
    }
    return configured;
  }

  /** Turns Composio's apps into ours and remembers them, so a later lookup by slug needs no call. */
  private remember(items: RawToolkit[]): Toolkit[] {
    return items
      .filter((t) => t.slug.toLowerCase() !== 'github')
      .map((t) => {
        // Composio often lists API_KEY under composio_managed_auth_schemes even when it has no
        // managed credentials (Gemini). Only non-key schemes mean "Connect" / managed OAuth.
        const managedSchemes = t.composio_managed_auth_schemes ?? [];
        const authSchemes = t.auth_schemes ?? [];
        const managed = !!t.no_auth || managedSchemes.some((s) => !KEY_SCHEMES.includes(s));
        const keyed =
          !managed && (authSchemes.some((a) => KEY_SCHEMES.includes(a)) || managedSchemes.some((a) => KEY_SCHEMES.includes(a)));
        const app: Toolkit = {
          slug: t.slug,
          name: t.name,
          ...(t.meta?.logo ? { logo: t.meta.logo } : {}),
          ...(t.meta?.description ? { description: t.meta.description.slice(0, 200) } : {}),
          tools: t.meta?.tools_count ?? 0,
          connectable: managed || keyed || this.authConfigs.has(t.slug),
          ...(keyed ? { keyed: true } : {}),
        };
        this.seen.set(t.slug, app);
        return app;
      });
  }

  /** The most used apps (cached an hour); the rest of the catalog is reached by searching Composio. */
  async catalog(): Promise<Toolkit[]> {
    if (this.catalogCache && Date.now() - this.catalogCache.at < CATALOG_TTL_MS) return this.catalogCache.list;
    const [page] = await Promise.all([this.call<{ items: RawToolkit[] }>('GET', `/toolkits?sort_by=usage&limit=${CATALOG_SIZE}`), this.syncConfiguredToolkits()]);
    const list = this.remember(page.items);
    this.catalogCache = { at: Date.now(), list };
    return list;
  }

  /** One app by slug, in the catalog or not. */
  async app(slug: string): Promise<Toolkit | undefined> {
    // ponytail: a slug search capped at 20; an app outranked by 20 others that mention its slug reads as unknown. Use GET /toolkits/{slug} if that shows up.
    return this.seen.get(slug) ?? (await this.searchCatalog(slug)).find((t) => t.slug === slug);
  }

  /** The popular apps, or by name only when Composio can't be read. */
  async popular(): Promise<Toolkit[]> {
    await this.catalog().catch(() => []);
    return Promise.all(
      Object.entries(POPULAR).map(async ([slug, name]) => (await this.app(slug).catch(() => undefined)) ?? { slug, name, tools: 0, connectable: true }),
    );
  }

  /** Apps matching a search (Composio looks at name, slug and description), best first. */
  async searchCatalog(query: string, limit = CATALOG_SIZE): Promise<Toolkit[]> {
    const q = query.trim().toLowerCase();
    if (!q) return (await this.catalog()).slice(0, limit);
    const [page] = await Promise.all([
      this.call<{ items: RawToolkit[] }>('GET', `/toolkits?search=${encodeURIComponent(q === 'x' ? 'twitter' : q)}&sort_by=usage&limit=${CATALOG_SIZE}`),
      Date.now() - this.authConfigsCheckedAt > 15_000 ? this.syncConfiguredToolkits() : undefined,
    ]);
    const first = (t: Toolkit) => Number((q === 'x' && t.slug === 'twitter') || t.name.toLowerCase().startsWith(q) || t.slug.startsWith(q));
    return this.remember(page.items)
      .sort((a, b) => first(b) - first(a))
      .slice(0, limit);
  }

  /** Look up an existing auth_config in Composio for `toolkit`, caching it if found. */
  private async existingAuthConfig(toolkit: string): Promise<string | undefined> {
    const known = this.authConfigs.get(toolkit);
    if (known) return known;
    const list = await this.call<{ items: { id: string; status?: string; toolkit?: { slug?: string } }[] }>('GET', `/auth_configs?toolkit_slug=${encodeURIComponent(toolkit)}`);
    const id = list.items.find((c) => c.toolkit?.slug === toolkit && c.status !== 'DISABLED')?.id;
    if (id) this.authConfigs.set(toolkit, id);
    return id;
  }

  /**
   * The toolkit's auth config: the one already there, else a new one. Composio's own sign-in when it has one; else the
   * person's own key (`keyScheme`), which they type on Composio's hosted page, so it never passes through Parly.
   */
  private async authConfig(toolkit: string, keyScheme?: string): Promise<string> {
    const existing = await this.existingAuthConfig(toolkit);
    if (existing) return existing;
    const config = keyScheme ? { type: 'use_custom_auth', authScheme: keyScheme, credentials: {} } : { type: 'use_composio_managed_auth' };
    const id = (await this.call<{ auth_config: { id: string } }>('POST', '/auth_configs', { toolkit: { slug: toolkit }, auth_config: config })).auth_config.id;
    this.authConfigs.set(toolkit, id);
    return id;
  }

  /** Where a person signs in to connect an app; Composio sends them back to `callbackUrl` (for `github`, installs Parly's GitHub App). */
  async connectUrl(userId: string, toolkit: string, callbackUrl: string): Promise<string> {
    if (!/^[a-z0-9_-]{1,80}$/.test(toolkit)) throw new HubError('invalid', `No app ${toolkit}`);
    if (toolkit === 'github') return githubInstallUrl(this.githubAppSlug);
    // The catalog says whether Composio can sign people in to it; without the catalog, Composio decides.
    const app = await this.app(toolkit).catch(() => undefined);
    if (app && !app.connectable) {
      const existing = await this.existingAuthConfig(toolkit).catch(() => undefined);
      if (existing) app.connectable = true;
      else throw new HubError('invalid', `${app.name} needs Parly's own app at ${app.name} (OAuth) and can't be connected from Parly yet`);
    }
    // A key app: which kind of key, from the app's own description of its sign-in.
    let keyScheme = app?.keyed && !this.authConfigs.has(toolkit) ? await this.keyScheme(toolkit) : undefined;
    try {
      const link = await this.call<{ redirect_url: string }>('POST', '/connected_accounts/link', {
        auth_config_id: await this.authConfig(toolkit, keyScheme),
        user_id: userId,
        callback_url: callbackUrl,
      });
      return link.redirect_url;
    } catch (err) {
      // Catalog said managed OAuth, but Composio has no managed credentials — retry with the person's key (Gemini).
      if (keyScheme || !(err instanceof HubError) || !/managed credentials|Default auth config not found/i.test(err.detail ?? '')) throw err;
      keyScheme = await this.keyScheme(toolkit).catch(() => undefined);
      if (!keyScheme) throw err;
      if (app) app.keyed = true;
      const link = await this.call<{ redirect_url: string }>('POST', '/connected_accounts/link', {
        auth_config_id: await this.authConfig(toolkit, keyScheme),
        user_id: userId,
        callback_url: callbackUrl,
      });
      return link.redirect_url;
    }
  }

  /** The key scheme a key app takes (API_KEY before the others). */
  private async keyScheme(toolkit: string): Promise<string> {
    const t = await this.call<{ auth_config_details?: { mode?: string }[] }>('GET', `/toolkits/${encodeURIComponent(toolkit)}`);
    const modes = (t.auth_config_details ?? []).map((d) => d.mode ?? '');
    const scheme = KEY_SCHEMES.find((k) => modes.includes(k));
    if (!scheme) throw new HubError('invalid', `${toolkit} doesn't take a key`);
    return scheme;
  }

  /** A person's connected accounts (only working ones count for their agents). */
  async accounts(userId: string): Promise<ToolAccount[]> {
    const list = await this.call<{ items: { id: string; status: string; toolkit: { slug: string }; auth_config?: { id: string } }[] }>('GET', `/connected_accounts?user_ids=${encodeURIComponent(userId)}&limit=200`);
    return list.items.map((a) => ({ id: a.id, toolkit: a.toolkit.slug, status: a.status, ...(a.auth_config?.id ? { authConfigId: a.auth_config.id } : {}) }));
  }

  /** Turns a trigger on for one of a person's connected accounts (Composio watches it and posts to our webhook). */
  /** An app's triggers (what Composio can watch for in it), cached like its tools. */
  async triggerTypes(toolkit: string): Promise<TriggerType[]> {
    const cached = this.triggerCache.get(toolkit);
    if (cached && Date.now() - cached.at < CATALOG_TTL_MS) return cached.list;
    const page = await this.call<{ items: RawTriggerType[] }>('GET', `/triggers_types?toolkit_slugs=${encodeURIComponent(toolkit)}&limit=200`);
    const list = page.items.map((t) => ({
      slug: t.slug,
      name: t.name ?? t.slug,
      description: (t.description ?? '').split('\n')[0]!.slice(0, 300),
      toolkit: t.toolkit?.slug ?? toolkit,
      config: t.config ?? { properties: {} },
    }));
    this.triggerCache.set(toolkit, { at: Date.now(), list });
    return list;
  }

  /** `userId`: who owns the connection (the person's Parly id); Composio requires it when the project has 2FA on. */
  async upsertTrigger(slug: string, userId: string, connectedAccountId: string, config: Record<string, unknown> = {}): Promise<string> {
    const r = await this.call<{ trigger_id: string }>('POST', `/trigger_instances/${encodeURIComponent(slug)}/upsert`, {
      user_id: userId,
      connected_account_id: connectedAccountId,
      trigger_config: config,
    });
    return r.trigger_id;
  }

  async deleteTrigger(triggerId: string): Promise<void> {
    await this.call('DELETE', `/trigger_instances/manage/${encodeURIComponent(triggerId)}`);
  }

  /** Disconnects one of a person's accounts; anyone else's is "not found". */
  async disconnect(userId: string, accountId: string): Promise<void> {
    if (!(await this.accounts(userId)).some((a) => a.id === accountId)) throw new HubError('not_found', `No connected account ${accountId}`);
    await this.call('DELETE', `/connected_accounts/${encodeURIComponent(accountId)}`);
  }

  private spec(t: RawTool, toolkit: string): ToolSpec {
    return { slug: t.slug, toolkit, description: (t.description ?? t.slug).slice(0, 600), parameters: t.input_parameters ?? { type: 'object', properties: {} }, readOnly: isReadOnly(t) };
  }

  /** An app's tools, as a small index (slug, what it does, read or write), cached an hour: GitHub alone has ~900. */
  private async index(toolkit: string): Promise<{ slug: string; text: string; readOnly: boolean; important: boolean }[]> {
    const cached = this.indexCache.get(toolkit);
    if (cached && Date.now() - cached.at < CATALOG_TTL_MS) return cached.list;
    const page = await this.call<{ items: RawTool[] }>('GET', `/tools?toolkit_slug=${encodeURIComponent(toolkit)}&limit=1000`);
    const list = page.items.map((t) => ({
      slug: t.slug,
      text: `${t.slug.replace(/_/g, ' ')} ${t.description ?? ''}`.toLowerCase(),
      readOnly: isReadOnly(t),
      important: !!t.tags?.includes('important'),
    }));
    this.indexCache.set(toolkit, { at: Date.now(), list });
    return list;
  }

  /**
   * Tools of these apps that match what the agent is looking for, best first; read-only ones only, unless it may act.
   * Ranked here by the words of the query (Composio's own search misses plain phrases like "list open issues").
   */
  async findTools(toolkits: string[], query: string, opts: { act: boolean; limit?: number }): Promise<ToolSpec[]> {
    const allowed = toolkits.filter((tk) => tk.toLowerCase() !== 'github');
    if (!allowed.length) return [];
    const limit = opts.limit ?? 8;
    const words = query.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !STOP.has(w));
    const stem = (w: string) => w.replace(/(ies|es|s)$/, '');
    const ranked = (
      await Promise.all(allowed.map((tk) => this.index(tk).then((list) => list.map((t) => ({ ...t, tk })), () => [])))
    )
      .flat()
      .filter((t) => opts.act || t.readOnly)
      .map((t) => ({ t, score: words.reduce((n, w) => n + (t.text.includes(stem(w)) ? (t.slug.toLowerCase().includes(stem(w)) ? 3 : 1) : 0), 0) + (t.important ? 0.5 : 0) }))
      .filter((x) => x.score >= 1)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
    const specs = await Promise.all(ranked.map(({ t }) => this.tool(t.slug, t.tk)));
    return specs.filter((s): s is ToolSpec => !!s);
  }

  /** One tool by slug (cached): to check it before running it. */
  async tool(slug: string, toolkit: string): Promise<ToolSpec | undefined> {
    if (toolkit.toLowerCase() === 'github' || slug.toLowerCase().startsWith('github_')) return undefined;
    const cached = this.toolCache.get(slug);
    if (cached && Date.now() - cached.at < SCHEMA_TTL_MS) return cached.tool;
    const t = await this.call<RawTool>('GET', `/tools/${encodeURIComponent(slug)}`).catch(() => undefined);
    if (!t?.slug) return undefined;
    const tool = this.spec(t, toolkit);
    this.toolCache.set(slug, { at: Date.now(), tool });
    return tool;
  }

  /** Runs a tool as `userId`; what it returned, or why it failed (for the model to read). */
  async execute(userId: string, slug: string, args: Record<string, unknown>, accountId?: string): Promise<{ ok: boolean; data?: unknown; error?: string }> {
    if (slug.toLowerCase().startsWith('github_')) {
      return { ok: false, error: "GitHub action tools now use Parly's native GitHub App (github_comment, github_open_pr, github_merge_pr, github_create_branch, github_put_file)." };
    }
    try {
      const r = await this.call<{ successful: boolean; data?: unknown; error?: string | null }>('POST', `/tools/execute/${encodeURIComponent(slug)}`, { user_id: userId, arguments: args, ...(accountId ? { connected_account_id: accountId } : {}) });
      return r.successful ? { ok: true, data: r.data } : { ok: false, error: r.error ?? 'failed' };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}

/**
 * Composio's webhook signature (Standard Webhooks): base64 HMAC-SHA256 of `${id}.${timestamp}.${rawBody}` with the
 * subscription's secret, in `webhook-signature` as `v1,<sig>` (possibly several, space-separated), within 5 minutes.
 */
export function verifyComposioSignature(raw: Buffer, headers: { id?: string; timestamp?: string; signature?: string }, secret: string, now = Date.now()): boolean {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature || Math.abs(now / 1000 - Number(timestamp)) > 300) return false;
  // Composio's own sample signs with the secret as text; Standard Webhooks decodes a `whsec_` one. Either passes.
  const keys = [Buffer.from(secret), ...(secret.startsWith('whsec_') ? [Buffer.from(secret.slice(6), 'base64')] : [])];
  const expected = keys.map((k) => createHmac('sha256', k).update(`${id}.${timestamp}.`).update(raw).digest());
  return signature.split(' ').some((part) => {
    const given = Buffer.from(part.includes(',') ? part.slice(part.indexOf(',') + 1) : part, 'base64');
    return expected.some((e) => given.length === e.length && timingSafeEqual(given, e));
  });
}

/** Something Composio can watch for in an app: its settings are a JSON schema (repo, label, interval, …). */
export interface TriggerType {
  slug: string;
  name: string;
  description: string;
  toolkit: string;
  config: { properties?: Record<string, { type?: string; title?: string; description?: string; default?: unknown; enum?: unknown[]; examples?: unknown[] }>; required?: string[] };
}
type RawTriggerType = { slug: string; name?: string; description?: string; toolkit?: { slug?: string }; config?: TriggerType['config'] };
