'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { adminAgentHref } from '../admin';
import { BUDGET_INVALID, budgetCredits } from '../labels';
import { hub, HubError, safeNext, type EndpointCheck } from '../hub';
import { channelHref, WORKSPACE_COOKIE } from '../routes';
import { attempt, clearToken, field, setToken } from './helpers';

/** Signs in with a Google ID token (from the Google button); the hub creates the person on first sign-in. `next` is where to go afterwards. */
export async function googleLogin(idToken: string, next?: string) {
  const back = safeNext(next);
  const loginBack = `/login${back ? `?next=${encodeURIComponent(back)}` : ''}`;
  const { token, first } = await attempt(loginBack, () =>
    hub<{ token: string; first?: { workspaceId: string; channelId: string } }>('/auth/google', {
      method: 'POST',
      body: { idToken },
      as: '',
    }),
  );
  await setToken(token);
  // A new person lands where Guide just said hello.
  redirect(back ?? (first ? channelHref(first.workspaceId, first.channelId) : '/'));
}

/**
 * Self-hosted password sign-in (PASSWORD_LOGIN=1): `mode` is sign-in, sign-up, or the first
 * owner's setup with the installer's secret. The password is only ever sent to the hub, which hashes it.
 */
export async function passwordLogin(form: FormData) {
  const mode = field(form, 'mode');
  const back = safeNext(field(form, 'next'));
  const path = mode === 'setup' ? '/auth/password/setup' : mode === 'signup' ? '/auth/password/signup' : '/auth/password';
  const body = {
    email: field(form, 'email'),
    password: String(form.get('password') ?? ''),
    ...(mode !== 'login' ? { name: field(form, 'name') } : {}),
    ...(mode === 'setup' ? { setupSecret: field(form, 'setupSecret') } : {}),
  };
  const { token, first } = await attempt(mode === 'setup' ? '/setup' : `/login${back ? `?next=${encodeURIComponent(back)}` : ''}`, () =>
    hub<{ token: string; first?: { workspaceId: string; channelId: string } }>(path, { method: 'POST', body, as: '' }),
  );
  await setToken(token);
  redirect(back ?? (first ? channelHref(first.workspaceId, first.channelId) : '/'));
}

/** Local testing only: the hub accepts "dev:<email>" when it runs with GOOGLE_AUTH_DEV=1. */
export async function googleDevLogin(form: FormData) {
  if (process.env.NEXT_PUBLIC_GOOGLE_AUTH_DEV !== '1') throw new Error('Dev sign-in is off');
  await googleLogin(`dev:${field(form, 'email')}`, field(form, 'next'));
}

/** Sets the logged-in person's avatar to a picked seed (or a random one). */
/** `back`: where to stay after saving (the welcome page keeps its welcome). */
export async function newAvatar(seed?: string, back = '/account') {
  const to = safeNext(back) ?? '/account';
  await attempt(to, () => hub('/agents/me/avatar', { method: 'POST', body: seed ? { avatar: seed } : {} }));
  revalidatePath('/', 'layout');
  redirect(to);
}

/**
 * The person's answer on an agent's consent page: allow it as one of their connections (`bot`),
 * or as a new one (`bot=new`, `name`), or deny. A browser sign-in goes back to the agent; a
 * device sign-in (a typed code) ends on /link.
 */
export async function answerSignIn(form: FormData) {
  const request = field(form, 'request');
  const back = `/oauth/consent?request=${encodeURIComponent(request)}`;
  const approve = field(form, 'answer') === 'approve';
  const bot = field(form, 'bot');
  const res = await attempt(back, () =>
    hub<{ redirect?: string; client?: { name: string } }>('/oauth/consent', {
      method: 'POST',
      body: { request, approve, ...(bot && bot !== 'new' ? { bot } : { name: field(form, 'name') || undefined }) },
    }),
  );
  revalidatePath('/', 'layout');
  // The agent's own callback (localhost, or its site): where the code (or the refusal) goes.
  if (res.redirect) redirect(res.redirect);
  redirect(`/link?${new URLSearchParams({ done: res.client?.name ?? 'your agent', ...(approve ? {} : { denied: '1' }) })}`);
}

/** /link: the code an agent showed (device sign-in) leads to its consent page. */
export async function lookupLinkCode(form: FormData) {
  const code = field(form, 'code');
  const back = `/link?code=${encodeURIComponent(code)}`;
  const req = await attempt(back, () => {
    if (!code) throw new HubError(400, 'Type the code your agent showed you');
    return hub<{ id: string }>(`/oauth/requests?${new URLSearchParams({ user_code: code })}`);
  });
  redirect(`/oauth/consent?request=${encodeURIComponent(req.id)}`);
}

export async function logout() {
  // Revokes a Google sign-in session on the hub too; a main token is left alone. Logging out still works if the hub is down.
  await hub('/auth/logout', { method: 'POST' }).catch(() => undefined);
  await clearToken();
  redirect('/');
}

/** Remembers the workspace the person has open, so "/" and old links come back to it. */
export async function rememberWorkspace(workspaceId: string) {
  (await cookies()).set(WORKSPACE_COOKIE, workspaceId, { sameSite: 'lax', path: '/', maxAge: 60 * 60 * 24 * 365 });
}

/** Super admin: `archive`, `restore`, `revoke-token` (the new token is thrown away) or `check` an agent. Logged by the hub. */
export async function adminAct(id: string, action: 'archive' | 'restore' | 'revoke-token' | 'check') {
  const back = adminAgentHref(id);
  const res = await attempt(back, () => hub<{ check?: EndpointCheck }>(`${back}/actions`, { method: 'POST', body: { action } }));
  const done =
    action === 'check'
      ? res.check?.ok
        ? 'The hub reached it with its credential.'
        : `Check failed: ${res.check && !res.check.ok ? res.check.problem : 'unknown'}`
      : { archive: 'Archived.', restore: 'Restored.', 'revoke-token': 'Token revoked; its OAuth sign-ins are ended too.' }[action];
  revalidatePath('/admin', 'layout');
  redirect(`${back}?done=${encodeURIComponent(done)}`);
}

/** Super admin: show or hide a client on the Connect page. */
export async function adminShowClient(client: string, shown: boolean) {
  await attempt('/admin/clients', () => hub('/admin/connect-clients', { method: 'POST', body: { client, shown } }));
  revalidatePath('/', 'layout');
  redirect('/admin/clients');
}

/** Super admin: a person's plan, with their own monthly allowance and agent limit if set (empty clears them). */
export async function adminSetPlan(id: string, form: FormData) {
  const back = adminAgentHref(id);
  const amount = (k: string) => (field(form, k) ? Number(field(form, k)) : null);
  await attempt(back, () =>
    hub(`${back}/billing`, {
      method: 'POST',
      body: {
        plan: field(form, 'plan'),
        allowanceUsd: amount('allowanceUsd'),
        maxWorkspaces: amount('maxWorkspaces'),
        maxParticipants: amount('maxParticipants'),
      },
    }),
  );
  revalidatePath('/admin', 'layout');
  redirect(`${back}?done=${encodeURIComponent('Plan saved.')}`);
}

/** Opens Paddle's customer portal for your subscription: cards, invoices, cancelling. */
export async function openBillingPortal() {
  const { url } = await attempt('/billing', () => hub<{ url: string }>('/me/billing/portal', { method: 'POST' }));
  redirect(url);
}

/** Opens Paddle's customer portal for a company's Team subscription (its owner): seats, cards, cancelling. */
export async function openPoolPortal(form: FormData) {
  const id = field(form, 'companyId');
  const { url } = await attempt('/billing', () => hub<{ url: string }>(`/companies/${encodeURIComponent(id)}/billing/portal`, { method: 'POST' }));
  redirect(url);
}

/** Company owner: sets its monthly budget in credits; an empty `credits` removes it. */
export async function setPoolBudget(form: FormData) {
  const id = field(form, 'companyId');
  const credits = budgetCredits(field(form, 'credits'));
  // NaN/Infinity would serialize to null and remove the budget, so reject them here.
  if (credits === undefined) redirect(`/billing?error=${encodeURIComponent(BUDGET_INVALID)}#company`);
  await attempt('/billing#company', () => hub(`/companies/${encodeURIComponent(id)}/budget`, { method: 'PUT', body: { credits } }));
  revalidatePath('/billing');
}

/** Before a Team checkout: creates your company (or returns the one you own) so Paddle bills it, not you. */
export async function createCompany(name: string): Promise<{ id: string } | { error: string }> {
  try {
    return await hub<{ id: string }>('/companies', { method: 'POST', body: { name } });
  } catch (e) {
    return { error: e instanceof HubError ? e.message : 'Could not create the company. Try again.' };
  }
}

/** Joins the Pro waitlist from Plan & billing: the Parly team gets an email, and it's stored by the hub (no admin page). */
export async function joinProWaitlist(form: FormData) {
  const plan = field(form, 'plan');
  // Old path on purpose: the web can deploy before the hub, which only gains /leads in this release. Rename later.
  await attempt('/billing', () => hub('/enterprise-leads', { method: 'POST', body: { plan } }));
  redirect(`/billing?asked=${encodeURIComponent(plan)}`);
}

