'use server';

import { revalidatePath } from 'next/cache';
import { hub } from '../hub';
import { attempt, field } from './helpers';

const co = (form: FormData) => `/companies/${encodeURIComponent(field(form, 'companyId'))}`;

async function call(path: string, method: 'POST' | 'DELETE', body?: unknown) {
  await attempt('/billing#company-members', () => hub(path, { method, ...(body ? { body } : {}) }));
  revalidatePath('/billing');
}

/** Owner: invites someone by email to join the company; a pending invite holds a seat. */
export async function inviteToCompany(form: FormData) {
  await call(`${co(form)}/invites`, 'POST', { email: field(form, 'email') });
}

/** Accept moves you into the company; decline (or an owner's revoke) drops the invite. */
export async function acceptCompanyInvite(form: FormData) {
  await call(`${co(form)}/accept`, 'POST');
}

export async function dropCompanyInvite(form: FormData) {
  await call(`${co(form)}/invites/${encodeURIComponent(field(form, 'email'))}`, 'DELETE');
}

/** Owner removes a member, or a member leaves (personId: yourself). */
export async function removeCompanyMember(form: FormData) {
  await call(`${co(form)}/members/${encodeURIComponent(field(form, 'personId'))}`, 'DELETE');
}
