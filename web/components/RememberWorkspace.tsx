'use client';

import { useEffect } from 'react';
import { WORKSPACE_COOKIE } from '@/lib/routes';

const WORKSPACE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/** Formats the client-side cookie string that records the active workspace immediately on navigation. */
export function formatWorkspaceCookie(workspaceId: string): string {
  return `${WORKSPACE_COOKIE}=${encodeURIComponent(workspaceId)}; path=/; max-age=${WORKSPACE_COOKIE_MAX_AGE}; samesite=lax`;
}

/**
 * Notes the open workspace in a cookie (a layout can't set one during RSC render), so "/", "/connect",
 * and legacy links come back here. Written synchronously to `document.cookie` on every workspace mount/change
 * (without gating on the server-rendered `remembered` prop, which stays stale in Next.js Router Cache when
 * switching back to a previously visited workspace, and without firing an extra Server Action POST).
 */
export function RememberWorkspace({ workspaceId }: { workspaceId: string; remembered?: string }) {
  useEffect(() => {
    document.cookie = formatWorkspaceCookie(workspaceId);
  }, [workspaceId]);
  return null;
}

