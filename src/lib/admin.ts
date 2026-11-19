import type { AgentRecord, ChannelRecord, Owned, WorkspaceRecord } from '../registry/types.js';

/**
 * Super admins have owner rights on every workspace and channel. Only a Google-linked account counts (`googleSub`:
 * Google checks email_verified); a password account's email is unverified, so it never matches SUPER_ADMIN_EMAILS
 * (space- or comma-separated).
 */
export function isSuperAdmin(agent: AgentRecord): boolean {
  return !!agent.googleSub && !!agent.email && isSuperAdminEmail(agent.email);
}

/** Parsed SUPER_ADMIN_EMAILS; rebuilt when the env string changes (tests mutate it). */
let superAdminEmailsRaw: string | undefined;
let superAdminEmails: string[] = [];

/** A verified email listed in SUPER_ADMIN_EMAILS. */
export function isSuperAdminEmail(email: string): boolean {
  const raw = process.env.SUPER_ADMIN_EMAILS ?? '';
  if (raw !== superAdminEmailsRaw) {
    superAdminEmailsRaw = raw;
    superAdminEmails = raw.split(/[\s,]+/).map((e) => e.trim().toLowerCase());
  }
  return superAdminEmails.includes(email);
}

/** Owner rights on a workspace or channel: its creator, an appointed co-owner, or a super admin. */
export function isOwner(owned: Owned, agent: AgentRecord): boolean {
  return owned.ownerId === agent.id || (owned.ownerIds ?? []).includes(agent.id) || isSuperAdmin(agent);
}

/** Who may manage a channel: its owners, and the owners of the workspace it lives in. */
export function canManageChannel(channel: ChannelRecord, workspace: WorkspaceRecord | undefined, agent: AgentRecord): boolean {
  // In a shared room the workspace's owner is just one side: another side's corner is theirs alone.
  return isOwner(channel, agent) || (!!workspace && !workspace.room && isOwner(workspace, agent));
}
