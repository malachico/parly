import { createHmac, timingSafeEqual } from 'node:crypto';
import { HubError } from '../lib/errors.js';
import { POPULAR, type TriggerType } from './composio.js';

/** Composio's Gmail "new email" trigger: its events read as an email (sender, subject), with filters on both. */
export const GMAIL_SLUG = 'GMAIL_NEW_GMAIL_MESSAGE';

/** GitHub App webhook events Parly routes to triggers (X-GitHub-Event). */
export const GITHUB_EVENTS = ['check_suite', 'pull_request', 'push', 'issue_comment'] as const;
export type GitHubEvent = (typeof GITHUB_EVENTS)[number];

/** Canonical trigger slugs for Parly's native GitHub App webhook events. */
const GITHUB_EVENT_SLUGS: Record<GitHubEvent, string> = {
  check_suite: 'GITHUB_CHECK_SUITE',
  pull_request: 'GITHUB_PULL_REQUEST',
  push: 'GITHUB_PUSH',
  issue_comment: 'GITHUB_ISSUE_COMMENT',
};

const GITHUB_REPO_PROP = {
  type: 'string',
  title: 'Repository',
  description: 'Repository to watch (owner/repo or name); leave blank for every repository your GitHub install covers',
  examples: ['malachico/parly'],
};

/** Native GitHub App trigger catalog (`repo` is optional on all; event-specific fields filter at webhook ingress). */
export const GITHUB_TRIGGER_TYPES: TriggerType[] = [
  {
    slug: GITHUB_EVENT_SLUGS.check_suite,
    name: 'Check Suite',
    description: 'When a GitHub check suite finishes on a repository.',
    toolkit: 'github',
    config: {
      properties: {
        repo: GITHUB_REPO_PROP,
        conclusion: {
          type: 'string',
          title: 'Conclusion',
          description: 'Only when check_suite.conclusion matches (e.g. failure)',
          enum: ['failure', 'success', 'cancelled', 'timed_out', 'action_required', 'neutral'],
        },
        branch: {
          type: 'string',
          title: 'Branch',
          description: 'Only for this branch (head_branch)',
          examples: ['main'],
        },
      },
    },
  },
  {
    slug: GITHUB_EVENT_SLUGS.pull_request,
    name: 'Pull Request',
    description: 'When a pull request is opened, updated, closed, or merged.',
    toolkit: 'github',
    config: {
      properties: {
        repo: GITHUB_REPO_PROP,
        action: {
          type: 'string',
          title: 'Action',
          description: 'Only for this pull_request action (e.g. opened, synchronize, closed, merged)',
          enum: ['opened', 'synchronize', 'closed', 'merged', 'reopened', 'ready_for_review'],
        },
        branch: {
          type: 'string',
          title: 'Branch',
          description: 'Only when base or head branch matches',
          examples: ['main'],
        },
      },
    },
  },
  {
    slug: GITHUB_EVENT_SLUGS.push,
    name: 'Push',
    description: 'When commits are pushed to a repository branch.',
    toolkit: 'github',
    config: {
      properties: {
        repo: GITHUB_REPO_PROP,
        branch: {
          type: 'string',
          title: 'Branch',
          description: 'Only pushes to this branch',
          examples: ['main'],
        },
      },
    },
  },
  {
    slug: GITHUB_EVENT_SLUGS.issue_comment,
    name: 'Issue Comment',
    description: 'When a comment is posted on an issue or pull request.',
    toolkit: 'github',
    config: {
      properties: {
        repo: GITHUB_REPO_PROP,
        action: {
          type: 'string',
          title: 'Action',
          description: 'Only for this comment action (defaults to non-deleted comments)',
          enum: ['created', 'edited', 'deleted'],
        },
      },
    },
  },
];

/**
 * GitHub's webhook signature (`X-Hub-Signature-256`): `sha256=<hex HMAC-SHA256 of raw body with secret>`.
 */
export function verifyGitHubSignature(raw: Buffer, signature: string | undefined, secret: string): boolean {
  if (!signature || !secret || !/^sha256=[0-9a-f]{64}$/i.test(signature)) return false;
  const given = Buffer.from(signature.slice(7), 'hex');
  const expected = createHmac('sha256', secret).update(raw).digest();
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Whether a GitHub trigger source watches this X-GitHub-Event (accepts native slugs and event names). */
export function matchesGitHubEvent(slug: string, event: GitHubEvent): boolean {
  const canonical = GITHUB_EVENT_SLUGS[event];
  return slug === canonical || slug === event || slug.startsWith(`${canonical}_`);
}

/**
 * Whether a GitHub webhook payload is for the repository a source watches.
 * Omitting `repo`/`owner` in `config` watches every repository on the owner's own installation (scoped in onGitHubEvent).
 */
export function matchesGitHubRepo(config: Record<string, unknown> | undefined, payload: Record<string, unknown>): boolean {
  const wantRepo = typeof config?.repo === 'string' ? config.repo.trim().toLowerCase() : '';
  const wantOwner = typeof config?.owner === 'string' ? config.owner.trim().toLowerCase() : '';
  if (!wantRepo && !wantOwner) return true;
  const repo = (payload.repository && typeof payload.repository === 'object' ? payload.repository : {}) as Record<string, unknown>;
  const full = typeof repo.full_name === 'string' ? repo.full_name.toLowerCase() : '';
  const name = typeof repo.name === 'string' ? repo.name.toLowerCase() : full.split('/')[1] ?? '';
  const ownerObj = (repo.owner && typeof repo.owner === 'object' ? repo.owner : {}) as Record<string, unknown>;
  const owner = typeof ownerObj.login === 'string' ? ownerObj.login.toLowerCase() : typeof ownerObj.name === 'string' ? ownerObj.name.toLowerCase() : full.split('/')[0] ?? '';
  if (wantOwner && owner !== wantOwner) return false;
  if (wantRepo) return wantRepo.includes('/') ? (full || `${owner}/${name}`) === wantRepo : name === wantRepo;
  return true;
}

/**
 * Whether a GitHub webhook payload passes ingress filtering for its event and optional source config
 * (`conclusion`, `action`, `branch`), dropping noisy intermediate/deletion events before fanout.
 */
export function matchesGitHubIngress(
  event: GitHubEvent,
  config: Record<string, unknown> | undefined,
  payload: Record<string, unknown>,
): boolean {
  const action = typeof payload.action === 'string' ? payload.action.toLowerCase() : '';
  const wantAction = typeof config?.action === 'string' ? config.action.trim().toLowerCase() : '';
  const wantConclusion = typeof config?.conclusion === 'string' ? config.conclusion.trim().toLowerCase() : '';
  const wantBranch = typeof config?.branch === 'string' ? config.branch.trim().replace(/^refs\/heads\//i, '').toLowerCase() : '';

  if (event === 'check_suite') {
    if (action && action !== 'completed') return false;
    const suite = (payload.check_suite && typeof payload.check_suite === 'object' ? payload.check_suite : {}) as Record<string, unknown>;
    const conclusion = typeof suite.conclusion === 'string' ? suite.conclusion.toLowerCase() : '';
    const branch = typeof suite.head_branch === 'string' ? suite.head_branch.replace(/^refs\/heads\//i, '').toLowerCase() : '';
    if (wantConclusion && conclusion !== wantConclusion) return false;
    if (wantBranch && branch !== wantBranch) return false;
    return true;
  }

  if (event === 'pull_request') {
    const pr = (payload.pull_request && typeof payload.pull_request === 'object' ? payload.pull_request : {}) as Record<string, unknown>;
    if (wantAction) {
      if (wantAction === 'merged') {
        if (action !== 'closed' || pr.merged !== true) return false;
      } else if (action !== wantAction) return false;
    }
    if (wantBranch) {
      const base = (pr.base && typeof pr.base === 'object' ? pr.base : {}) as Record<string, unknown>;
      const head = (pr.head && typeof pr.head === 'object' ? pr.head : {}) as Record<string, unknown>;
      const baseRef = typeof base.ref === 'string' ? base.ref.replace(/^refs\/heads\//i, '').toLowerCase() : '';
      const headRef = typeof head.ref === 'string' ? head.ref.replace(/^refs\/heads\//i, '').toLowerCase() : '';
      if (baseRef !== wantBranch && headRef !== wantBranch) return false;
    }
    return true;
  }

  if (event === 'push') {
    if (payload.deleted === true) return false;
    if (wantBranch) {
      const ref = typeof payload.ref === 'string' ? payload.ref.replace(/^refs\/heads\//i, '').toLowerCase() : '';
      if (ref !== wantBranch) return false;
    }
    return true;
  }

  if (event === 'issue_comment') {
    if (!wantAction && action === 'deleted') return false;
    if (wantAction && action !== wantAction) return false;
    return true;
  }

  return true;
}

/** One agent's trigger as it sees it: a source (what is watched) and its listener (who hears it, where, with what filter). */
export interface AgentTrigger {
  id: string;
  agentId: string;
  ownerId: string;
  /** Composio's trigger type (GITHUB_PULL_REQUEST_EVENT, …), its app, and its name ("New Pull Request Created"). */
  slug: string;
  toolkit: string;
  label: string;
  /** Its settings, as Composio's trigger type asks for them (repo, label, …). */
  config?: Record<string, unknown>;
  /** Where events are posted: this channel (mentioning the agent, so the team sees them); else the owner's DM with it. */
  channelId?: string;
  /** Composio's trigger instance (ti_…), and the connected account it watches (omitted for native webhook sources). */
  composioId?: string;
  connectedAccountId?: string;
  /** Only events that match get through (case-insensitive "contains"; from/subject for emails); empty means all. */
  filter: { from?: string; subject?: string; contains?: string };
  /** Optional instruction from the owner for what the agent should do when this trigger fires. */
  task?: string;
  createdAt: string;
  lastFiredAt?: string;
  fired?: number;
}

/** Its name in chat, instead of its owner's: "Gmail trigger". */
export const triggerName = (t: Pick<AgentTrigger, 'toolkit'>) => `${appName(t.toolkit)} trigger`;
/** Display name for a toolkit slug; POPULAR covers Composio apps, github is Parly's native App. */
export const appName = (toolkit: string) =>
  (toolkit === 'github' ? 'GitHub' : POPULAR[toolkit]) ?? toolkit.charAt(0).toUpperCase() + toolkit.slice(1);

/**
 * Any app's event as a few readable lines: its short values, keyed by where they sit ("pull_request.title: …").
 * ponytail: depth 3, 25 lines, 300 characters a value; enough to know what happened, the agent can look up the rest.
 */
export function summarize(data: unknown): string {
  const lines: string[] = [];
  const walk = (v: unknown, path: string, depth: number) => {
    if (lines.length >= 25 || v === null || v === undefined || v === '') return;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      const text = String(v).replace(/\s+/g, ' ').trim();
      if (text) lines.push(`${path}: ${text.length > 300 ? `${text.slice(0, 297)}…` : text}`);
      return;
    }
    if (depth >= 3) return;
    if (Array.isArray(v)) return v.slice(0, 5).forEach((x, i) => walk(x, `${path}[${i}]`, depth + 1));
    if (typeof v === 'object') for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(x, path ? `${path}.${k}` : k, depth + 1);
  };
  walk(data, '', 0);
  return lines.join('\n');
}

/**
 * The settings a person entered, as the trigger type's schema takes them: its own fields only, numbers and yes/no
 * read as such. Missing required ones are named.
 */
export function triggerConfig(
  schema: { properties?: Record<string, { type?: string; enum?: unknown[] }>; required?: string[] } | undefined,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const props = schema?.properties ?? {};
  const out: Record<string, unknown> = {};
  for (const [k, p] of Object.entries(props)) {
    const v = input[k];
    if (v === undefined || v === null || (typeof v === 'string' && !v.trim())) continue;
    if (p.type === 'number' || p.type === 'integer') {
      const n = Number(v);
      if (Number.isFinite(n)) out[k] = n;
    } else if (p.type === 'boolean') out[k] = v === true || v === 'true' || v === 'on';
    else if (p.type === 'array') out[k] = (Array.isArray(v) ? v : String(v).split(',')).map((x) => String(x).trim()).filter(Boolean);
    else out[k] = String(v).trim().slice(0, 500);
    if (p.enum?.length && out[k] !== undefined && !p.enum.includes(out[k])) {
      throw new HubError('invalid', `Invalid ${k} "${String(out[k])}" (expected ${p.enum.join(', ')})`);
    }
  }
  if (props.repo && !props.owner && typeof input.owner === 'string' && input.owner.trim()) {
    const owner = input.owner.trim().slice(0, 200);
    if (typeof out.repo === 'string' && !out.repo.includes('/')) out.repo = `${owner}/${out.repo}`;
    else if (!out.repo) out.owner = owner;
  }
  const missing = (schema?.required ?? []).filter((k) => out[k] === undefined);
  if (missing.length) throw new HubError('invalid', `Fill in ${missing.join(', ')}`);
  return out;
}

/** An email as a trigger delivers it, read loosely (Composio's Gmail payload has used several field names). */
export function emailOf(data: Record<string, unknown>): { from: string; subject: string; text: string } {
  const pick = (...v: unknown[]) => (v.find((x) => typeof x === 'string' && x.trim()) as string | undefined)?.trim() ?? '';
  const nested = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);
  const payload = nested(data.payload);
  const preview = nested(data.preview);
  return {
    from: pick(data.sender, data.from, payload?.sender),
    subject: pick(data.subject, payload?.subject),
    text: pick(data.message_text, preview?.body, data.snippet, data.body, data.messageText).slice(0, 1500),
  };
}

const has = (hay: string, needle?: string) => !needle || hay.toLowerCase().includes(needle.toLowerCase());

function matches(filter: AgentTrigger['filter'], email: { from: string; subject: string }): boolean {
  return has(email.from, filter.from) && has(email.subject, filter.subject);
}

/** Whether an event gets through a trigger's filters: an email by sender and subject, anything by "contains". */
export function passes(t: AgentTrigger, data: Record<string, unknown>): boolean {
  if (t.slug === GMAIL_SLUG && !matches(t.filter, emailOf(data))) return false;
  return has(JSON.stringify(data), t.filter.contains);
}

/**
 * `triggerSources/{id}`: something Composio watches in one of a person's connected apps (an app event with its
 * settings), shared by everyone who listens to it. Archived, not deleted: its listeners and their history stay.
 */
export interface TriggerSource {
  id: string;
  ownerId: string;
  slug: string;
  toolkit: string;
  label: string;
  config?: Record<string, unknown>;
  composioId?: string;
  connectedAccountId?: string;
  createdAt: string;
  archivedAt?: string;
  fired?: number;
  lastFiredAt?: string;
}

/**
 * `triggerListeners/{id}`: who hears a source's events, with its own filter and instruction. agentId alone: the
 * owner's DM with that agent; channelId too: posted there, mentioning the agent; channelId alone: posted for the team.
 */
export interface TriggerListener {
  id: string;
  sourceId: string;
  ownerId: string;
  agentId?: string;
  channelId?: string;
  filter: { from?: string; subject?: string; contains?: string };
  task?: string;
  enabled: boolean;
  createdAt: string;
  detachedAt?: string;
  delivered?: number;
  lastDeliveredAt?: string;
}

/** A listener with its source, in the shape the agent card and the agent tools read (one "trigger"). */
export function asTrigger(s: TriggerSource, l: TriggerListener): AgentTrigger {
  return {
    id: l.id,
    agentId: l.agentId ?? '',
    ownerId: l.ownerId,
    slug: s.slug,
    toolkit: s.toolkit,
    label: s.label,
    ...(s.config ? { config: s.config } : {}),
    ...(l.channelId ? { channelId: l.channelId } : {}),
    ...(s.composioId ? { composioId: s.composioId } : {}),
    ...(s.connectedAccountId ? { connectedAccountId: s.connectedAccountId } : {}),
    filter: l.filter,
    ...(l.task ? { task: l.task } : {}),
    createdAt: l.createdAt,
    ...(l.lastDeliveredAt ? { lastFiredAt: l.lastDeliveredAt } : {}),
    ...(l.delivered ? { fired: l.delivered } : {}),
  };
}

export { TriggerStore } from './triggerStore.js';
