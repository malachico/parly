import type { Database } from '../db/types.js';
import type { NoticeMailer } from '../lib/mail.js';
import type { HubService } from '../hub/hubService.js';
import { HubError } from '../lib/errors.js';
import { avatarOf } from '../lib/present.js';
import { isListening } from '../registry/registry.js';
import type { AgentRecord } from '../registry/types.js';
import { AdminStore } from './store.js';

/**
 * The hub as a whole, for super admins: health, every agent, and a few actions on them.
 * Never message text, file contents, room briefs or credentials: only who, when, what state, how many.
 * Every action is written to `admin_log`.
 */

/** Most rows any one overview query reads; past it the numbers say `truncated`. */
// ponytail: reads raw docs and counts in memory; switch to count() aggregations or a rollup doc if a day holds more than this
const SCAN_LIMIT = 10_000;

export type AdminAction = 'archive' | 'restore' | 'revoke-token' | 'check' | 'plan';

/** A person asking for a client the Connect page doesn't offer yet (POST /client-requests). */
export interface ClientRequest {
  id: string;
  text: string;
  email: string;
  name: string;
  agentId: string;
  at: string;
}

/** Longest client request, in characters. */
const CLIENT_REQUEST_MAX = 500;

/** `enterpriseLeads/{id}` (old collection name): someone who joined the Pro waitlist from Account → Billing while checkout is closed. */
export interface PlanLead {
  id: string;
  agentId: string;
  name: string;
  email: string;
  /** Only on old leads. */
  company?: string;
  message?: string;
  /** `pro-monthly` or `pro-yearly`; unset on old leads. */
  plan?: string;
  at: string;
}

const PLAN_LABEL: Record<string, string> = { 'pro-monthly': 'Pro monthly ($20/month)', 'pro-yearly': 'Pro yearly ($200/year)' };

export interface AdminLogEntry {
  at: string;
  adminId: string;
  adminEmail: string;
  action: AdminAction;
  targetId: string;
  targetName: string;
  /** What came of it, e.g. a check's problem. */
  detail?: string;
}

/** An agent as the admin pages show it: identity and state, never its token or credential. */
function adminRow(a: AgentRecord) {
  return {
    id: a.id,
    name: a.name,
    kind: a.kind,
    avatar: avatarOf(a),
    ...(a.kind === 'human' && a.email ? { email: a.email } : {}),
    ...(a.ownerId ? { owner: { id: a.ownerId, name: a.ownerName ?? '' } } : {}),
    ...(a.followsOwner ? { followsOwner: true } : {}),
    public: a.public ?? false,
    ...(a.archived ? { archived: true } : {}),
    createdAt: a.createdAt,
    lastSeen: a.lastSeen,
    ...(a.kind === 'mailbox' ? { listening: isListening(a) } : {}),
    ...(a.url ? { url: a.url } : {}),
    ...(a.credential ? { credential: a.credential.type } : {}),
    ...(a.authProblem ? { authProblem: a.authProblem } : {}),
    workspaces: (a.workspaces ?? []).length,
    channels: (a.channels ?? []).length,
  };
}

export class Admin {
  constructor(
    db: Database,
    private readonly hub: HubService,
    /** Emails the super admins (plan leads); unset, nothing is emailed. */
    private readonly notify?: NoticeMailer,
  ) {
    this.store = new AdminStore(db);
  }

  private readonly store: AdminStore;

  /** One batch of the 90-day context graph backfill; rerun until `done`. */
  async backfillGraph(limit?: number) {
    if (!this.hub.backfillGraph) throw new HubError('unavailable', 'The context graph is off on this hub');
    return this.hub.backfillGraph({ limit });
  }

  /** The health page: agents, messages in the last `hours` (one bucket per hour), and endpoint agents with problems. */
  async overview(hours = 24, now = Date.now()) {
    const since = new Date(now - hours * 60 * 60_000).toISOString();
    const [agents, messageTimes] = await Promise.all([
      this.hub.registry.list(),
      this.store.messageTimesSince(now - hours * 60 * 60_000, SCAN_LIMIT),
    ]);
    const startHour = Math.floor((now - hours * 60 * 60_000) / 3_600_000) * 3_600_000;
    const hourly = Array.from({ length: hours + 1 }, (_, i) => ({ hour: new Date(startHour + i * 3_600_000).toISOString(), messages: 0 }));
    for (const at of messageTimes) {
      const bucket = hourly[Math.floor((at - startHour) / 3_600_000)];
      if (bucket) bucket.messages++;
    }
    const live = agents.filter((a) => !a.archived);
    return {
      generatedAt: new Date(now).toISOString(),
      since,
      hours,
      agents: {
        people: live.filter((a) => a.kind === 'human').length,
        mailbox: live.filter((a) => a.kind === 'mailbox').length,
        endpoint: live.filter((a) => a.kind === 'endpoint').length,
        public: live.filter((a) => a.public).length,
        archived: agents.length - live.length,
        active: live.filter((a) => a.lastSeen >= since).length,
        listening: live.filter((a) => isListening(a, now)).length,
      },
      messages: { total: messageTimes.length, hourly, truncated: messageTimes.length === SCAN_LIMIT },
      endpointProblems: live.filter((a) => a.authProblem).map((a) => adminRow(a)),
    };
  }

  /** Sets a person's plan (and any limit overrides), logged like every admin action. */
  async setPlan(actor: AgentRecord, id: string, change: { plan: 'free' | 'pro' | 'team'; allowanceUsd?: number | null; maxWorkspaces?: number | null; maxParticipants?: number | null }) {
    const person = await this.hub.registry.get(id);
    if (!person || person.kind !== 'human') throw new HubError('not_found', `No person ${id}`);
    for (const v of [change.allowanceUsd, change.maxWorkspaces, change.maxParticipants]) if (v != null && !(Number.isFinite(v) && v >= 0)) throw new HubError('invalid', 'Amounts must be zero or more');
    const billing = await this.hub.billing.setPlan(id, change);
    const extras = [change.allowanceUsd != null && `$${change.allowanceUsd}/month`, change.maxWorkspaces != null && `${change.maxWorkspaces} workspaces`, change.maxParticipants != null && `${change.maxParticipants} participants per workspace`].filter(Boolean).join(', ');
    await this.log(actor, 'plan', person, `${change.plan}${extras ? ` (${extras})` : ''}`);
    return billing;
  }

  /** This month's model use by agent (the costliest 200), most tokens first: who it is, whose it is, tokens, calls and cost. */
  async usage() {
    const rows = await this.hub.llm.topAgents();
    const names = new Map((await this.hub.registry.getMany(rows.flatMap((r) => [r.agentId, r.ownerId]))).map((a) => [a.id, a]));
    return {
      period: rows[0]?.period ?? new Date().toISOString().slice(0, 7),
      agents: rows.map((r) => ({ ...r, name: names.get(r.agentId)?.name ?? r.agentId, owner: names.get(r.ownerId)?.name ?? r.ownerId, cloud: !!names.get(r.agentId)?.cloud })),
    };
  }

  /**
   * Every agent, people included, most recently seen first. `filter`: problem (an auth problem),
   * public, archived (otherwise archived ones are left out).
   */
  // ponytail: loads every agent like Registry.search; page the query once there are tens of thousands
  async agents(opts: { q?: string; kind?: string; filter?: string; offset?: number; limit?: number } = {}) {
    const all = await this.hub.registry.list();
    const q = opts.q?.trim().toLowerCase();
    const rows = all
      .filter((a) => {
        if (opts.kind && a.kind !== opts.kind) return false;
        if (opts.filter === 'archived' ? !a.archived : a.archived) return false;
        if (opts.filter === 'problem' && !a.authProblem) return false;
        if (opts.filter === 'public' && !a.public) return false;
        return !q || [a.id, a.name, a.email ?? '', a.ownerName ?? '', a.url ?? ''].some((s) => s.toLowerCase().includes(q));
      })
      .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
    const offset = Math.max(0, opts.offset ?? 0);
    const limit = Math.min(Math.max(1, opts.limit ?? 50), 200);
    return { total: rows.length, offset, agents: rows.slice(offset, offset + limit).map((a) => adminRow(a)) };
  }

  /** One agent: its row, where it is, what it owns, and its latest conversations (no message text). */
  async agent(id: string) {
    const a = await this.hub.registry.get(id);
    if (!a) throw new HubError('not_found', `No agent ${id}`);
    const [owner, bots, conversations, workspaces, billing] = await Promise.all([
      a.ownerId ? this.hub.registry.get(a.ownerId) : undefined,
      a.kind === 'human' ? this.hub.registry.botsOf(a) : [],
      this.hub.chat.store.mine(a.id, 30),
      Promise.all((a.workspaces ?? []).map((w) => this.hub.registry.workspaceById(w))),
      a.kind === 'human' ? Promise.all([this.hub.llm.limits(a.id), this.hub.billing.get(a.id)]) : undefined,
    ]);
    return {
      ...adminRow(a),
      description: a.description,
      skills: a.skills.map((s) => s.name || s.id),
      ...(a.auth ? { auth: a.auth } : {}),
      ...(owner ? { owner: { id: owner.id, name: owner.name, ...(owner.email ? { email: owner.email } : {}) } } : {}),
      workspaceList: workspaces.filter((w): w is NonNullable<typeof w> => !!w).map((w) => ({ id: w.id, name: w.name, ...(w.archived ? { archived: true } : {}) })),
      bots: bots.map((b) => adminRow(b)),
      conversations: conversations.map((c) => ({ id: c.id, kind: c.kind, messages: c.seq, lastAt: c.lastAt })),
      ...(billing
        ? {
            billing: {
              plan: billing[0].plan,
              monthlyUsd: billing[0].monthlyMicros / 1e6,
              extraUsd: billing[0].extraMicros / 1e6,
              maxWorkspaces: billing[0].maxWorkspaces,
              maxParticipants: billing[0].maxParticipants,
              ...(billing[1]?.allowanceUsd !== undefined ? { allowanceUsd: billing[1].allowanceUsd } : {}),
              ...(billing[1]?.maxWorkspaces !== undefined ? { customMaxWorkspaces: billing[1].maxWorkspaces } : {}),
              ...(billing[1]?.maxParticipants !== undefined ? { customMaxParticipants: billing[1].maxParticipants } : {}),
              ...(billing[1]?.paddleSubscriptionId ? { paddle: true } : {}),
            },
          }
        : {}),
    };
  }

  /** Archives or restores a bot, revokes its token (nobody gets the new one), or checks its endpoint. Logged. */
  async act(admin: AgentRecord, id: string, action: AdminAction) {
    const target = await this.hub.registry.get(id);
    if (!target) throw new HubError('not_found', `No agent ${id}`);
    let detail: string | undefined;
    let check: { ok: boolean; problem?: string } | undefined;
    switch (action) {
      case 'archive':
      case 'restore':
        await this.hub.registry.setArchived(admin, id, action === 'archive');
        break;
      case 'revoke-token':
        // The new token is dropped: the owner makes another (Connect page, or a pairing code).
        await this.hub.registry.rotateToken(target);
        break;
      case 'check':
        check = await this.hub.checkEndpoint(target);
        if (!check) throw new HubError('invalid', `${target.name} has no URL to check`);
        detail = check.ok ? 'ok' : check.problem;
        break;
      default:
        throw new HubError('invalid', `Unknown action ${String(action)}`);
    }
    await this.log(admin, action, target, detail);
    return { ok: true, ...(check ? { check } : {}), agent: adminRow((await this.hub.registry.get(id)) ?? target) };
  }

  private async log(admin: AgentRecord, action: AdminAction, target: AgentRecord, detail?: string): Promise<void> {
    const entry: AdminLogEntry = { at: new Date().toISOString(), adminId: admin.id, adminEmail: admin.email ?? '', action, targetId: target.id, targetName: target.name, ...(detail ? { detail } : {}) };
    await this.store.addLog(entry);
  }

  /**
   * A signed-in person asks for a client; super admins see it with their email.
   * ponytail: no rate limit beyond sign-in; one per person per minute if it gets spammed.
   */
  async addClientRequest(person: AgentRecord, text: string): Promise<{ id: string; at: string }> {
    if (person.kind !== 'human' || !person.email) throw new HubError('forbidden', 'Sign in with Google to send a request');
    const t = text.trim();
    if (!t) throw new HubError('invalid', 'Say which client you want');
    if (t.length > CLIENT_REQUEST_MAX) throw new HubError('invalid', `Keep it under ${CLIENT_REQUEST_MAX} characters`);
    const request = await this.store.addClientRequest({ text: t, email: person.email, name: person.name, agentId: person.id, at: new Date().toISOString() });
    return { id: request.id, at: request.at };
  }

  /** Someone joins the Pro waitlist (Account → Billing): kept for /admin/leads and emailed (LEADS_EMAIL, else the super admins). */
  async addLead(person: AgentRecord, input: { plan?: string }): Promise<{ id: string }> {
    if (person.kind !== 'human' || !person.email) throw new HubError('forbidden', 'Sign in with Google to join the waitlist');
    const plan = input.plan ?? '';
    if (!Object.hasOwn(PLAN_LABEL, plan)) throw new HubError('invalid', 'plan must be pro-monthly or pro-yearly');
    const lead = await this.store.addLead({ agentId: person.id, name: person.name, email: person.email, plan, at: new Date().toISOString() });
    const admins = (process.env.LEADS_EMAIL || process.env.SUPER_ADMIN_EMAILS || '').split(/[\s,]+/).filter(Boolean);
    await this.notify?.(
      admins,
      `Parly ${PLAN_LABEL[plan]} request: ${lead.name}`,
      `${lead.name} <${lead.email}> wants ${PLAN_LABEL[plan]} (checkout isn't open yet). Email them when it is.\n\nAll leads: /admin/leads`,
    ).catch((err) => console.error('plan lead not emailed', err));
    return { id: lead.id };
  }

  /** Plan leads, newest first. */
  async leads(limit = 200): Promise<PlanLead[]> {
    return this.store.listLeads(Math.min(Math.max(1, limit), 500));
  }

  /** Client requests, newest first. */
  async clientRequests(limit = 200): Promise<ClientRequest[]> {
    return this.store.listClientRequests(Math.min(Math.max(1, limit), 500));
  }

  /** Which clients the Connect page shows, by key, where an admin chose (`settings/connect`); unset keys keep the page's default. */
  async connectClients(): Promise<Record<string, boolean>> {
    return this.store.connectShown();
  }

  /** Shows or hides one client on the Connect page. */
  async setConnectClient(key: string, shown: boolean): Promise<Record<string, boolean>> {
    if (!/^[a-z0-9-]{1,40}$/.test(key)) throw new HubError('invalid', 'client must be a client key');
    await this.store.setConnectShown(key, shown);
    return this.connectClients();
  }

  /** The latest admin actions, newest first. */
  async logEntries(limit = 100): Promise<AdminLogEntry[]> {
    return this.store.listLog(Math.min(Math.max(1, limit), 500));
  }
}
