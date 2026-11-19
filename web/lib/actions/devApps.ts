'use server';

import { redirect } from 'next/navigation';
import { hub } from '../hub';
import { devAppsHref } from '../routes';
import { attempt, field, setFlash } from './helpers';

/** Shown once on the next view of the apps page; secrets ride in a short-lived cookie, never the URL. */
const FLASH = 'flash_dev_app';

/** Makes an app and shows its API key and webhook secret once. */
export async function createDevApp(ws: string, form: FormData) {
  const back = devAppsHref(ws);
  const webhookUrl = field(form, 'webhookUrl');
  const { app, key } = await attempt(back, () =>
    hub<{ app: { id: string; name: string; webhookSecret: string }; key: string }>(`/workspaces/${encodeURIComponent(ws)}/apps`, { method: 'POST', body: { name: field(form, 'name'), ...(webhookUrl ? { webhookUrl } : {}) } }),
  );
  await setFlash(FLASH, JSON.stringify({ appId: app.id, key, webhookSecret: app.webhookSecret }), back);
  redirect(`${back}?made=1`);
}

/** Another key for an app (to rotate), shown once. */
export async function addDevAppKey(ws: string, appId: string) {
  const back = devAppsHref(ws);
  const { key } = await attempt(back, () => hub<{ key: string }>(`/workspaces/${encodeURIComponent(ws)}/apps/${encodeURIComponent(appId)}/keys`, { method: 'POST' }));
  await setFlash(FLASH, JSON.stringify({ appId, key }), back);
  redirect(`${back}?made=1`);
}

export async function revokeDevAppKey(ws: string, appId: string, prefix: string) {
  const back = devAppsHref(ws);
  await attempt(back, () => hub(`/workspaces/${encodeURIComponent(ws)}/apps/${encodeURIComponent(appId)}/keys/${encodeURIComponent(prefix)}`, { method: 'DELETE' }));
  redirect(back);
}

export async function deleteDevApp(ws: string, appId: string) {
  const back = devAppsHref(ws);
  await attempt(back, () => hub(`/workspaces/${encodeURIComponent(ws)}/apps/${encodeURIComponent(appId)}`, { method: 'DELETE' }));
  redirect(back);
}
