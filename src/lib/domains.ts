import { HubError } from './errors.js';

/**
 * Public mail providers: anyone can get an address there, so a workspace must never let a whole
 * one of these domains in. People with such addresses are invited by email instead.
 */
export const FREE_MAIL_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'msn.com',
  'yahoo.com',
  'ymail.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'aol.com',
  'proton.me',
  'protonmail.com',
  'pm.me',
  'gmx.com',
  'gmx.de',
  'gmx.net',
  'mail.com',
  'yandex.com',
  'yandex.ru',
  'fastmail.com',
  'hey.com',
  'zoho.com',
  'tutanota.com',
  'tuta.io',
  'qq.com',
  '163.com',
  '126.com',
]);

const DOMAIN_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

/** The domain of a (normalized) email address. */
export function domainOf(email: string): string {
  return email.slice(email.lastIndexOf('@') + 1).toLowerCase();
}

/** A domain a workspace may auto-join: lowercased, no leading "@", a real-looking host, and not a public mail provider. */
export function normalizeDomain(raw: string): string {
  const domain = raw.trim().toLowerCase().replace(/^@/, '');
  if (!domain || domain.length > 253 || !DOMAIN_RE.test(domain)) throw new HubError('invalid', `"${raw}" is not a valid domain (like acme.com)`);
  if (FREE_MAIL_DOMAINS.has(domain)) {
    throw new HubError('invalid', `${domain} is a public mail provider; anyone could join. Invite people with such addresses by email instead.`);
  }
  return domain;
}
