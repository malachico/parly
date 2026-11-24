import { notFound } from 'next/navigation';
import { HubError, hubOrLogin } from './hub';

/** The hub's /admin API (super admins only; anyone else gets a 404 there, and here). */

export interface AdminRow {
  id: string;
  name: string;
  kind: 'endpoint' | 'mailbox' | 'human';
  avatar: string;
  email?: string;
  owner?: { id: string; name: string; email?: string };
  followsOwner?: boolean;
  public: boolean;
  archived?: boolean;
  createdAt: string;
  lastSeen: string;
  listening?: boolean;
  url?: string;
  credential?: string;
  authProblem?: string;
  workspaces: number;
  channels: number;
}

export interface Hour {
  hour: string;
  messages: number;
}

export interface Overview {
  generatedAt: string;
  since: string;
  hours: number;
  agents: { people: number; mailbox: number; endpoint: number; public: number; archived: number; active: number; listening: number };
  messages: { total: number; hourly: Hour[]; truncated: boolean };
  endpointProblems: AdminRow[];
}

export interface AdminAgent extends AdminRow {
  description: string;
  skills: string[];
  workspaceList: { id: string; name: string; archived?: boolean }[];
  bots: AdminRow[];
  /** Its latest conversations: kind, how many messages, when the last one came (no text). */
  conversations: { id: string; kind: 'channel' | 'thread' | 'dm'; messages: number; lastAt: string }[];
  /** People: their plan, what it gives them now, and any admin overrides. */
  billing?: {
    plan: Plan;
    monthlyUsd: number;
    extraUsd: number;
    maxWorkspaces: number;
    maxParticipants: number;
    allowanceUsd?: number;
    customMaxWorkspaces?: number;
    customMaxParticipants?: number;
    paddle?: boolean;
    /** @deprecated one release; hub still may send these */
    maxHired?: number;
    maxConnected?: number;
    customMaxHired?: number;
    customMaxConnected?: number;
  };
}

type Plan = 'free' | 'pro' | 'team';

export interface AdminLogEntry {
  at: string;
  adminId: string;
  adminEmail: string;
  action: 'archive' | 'restore' | 'revoke-token' | 'check' | 'plan';
  targetId: string;
  targetName: string;
  detail?: string;
}

export interface ClientRequest {
  id: string;
  text: string;
  email: string;
  name: string;
  agentId: string;
  at: string;
}

export const adminAgentHref = (id: string) => `/admin/agents/${encodeURIComponent(id)}`;

/** GET from the admin API; a 404 (not an admin, or no such agent) is this site's 404 too. */
export async function adminGet<T>(path: string, next: string): Promise<T> {
  try {
    return await hubOrLogin<T>(path, { next });
  } catch (err) {
    if (err instanceof HubError && err.status === 404) notFound();
    throw err;
  }
}

/** Someone on the Pro waitlist (GET /admin/leads). */
export interface PlanLead {
  id: string;
  agentId: string;
  name: string;
  email: string;
  /** `pro-monthly` or `pro-yearly`; old leads may have none. */
  plan?: string;
  at: string;
}
