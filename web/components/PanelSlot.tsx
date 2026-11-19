'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Icon } from '@/components/Icon';
import { PanelSkeleton } from '@/components/PanelSkeleton';
import { timelineParamsChanged, wsHref } from '@/lib/routes';

const PANEL_NAV_EVENT = 'parly:panel-nav';

export function notifyPanelNav(href: string) {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent<string>(PANEL_NAV_EVENT, { detail: href }));
  }
}

export function isIntraChannelSideNav(currentPath: string, currentSearch: string, to: URL): boolean {
  if (decodeURIComponent(to.pathname) !== decodeURIComponent(currentPath)) return false;
  if (!decodeURIComponent(currentPath).includes('/c/channel:')) return false;
  return !timelineParamsChanged(new URLSearchParams(currentSearch), to.searchParams);
}

export function resolveClosingPanelClick(
  ws: string,
  currentPath: string,
  currentSearch: string,
  targetHref: string,
  origin = 'http://localhost',
): 'ignore' | 'reopen' | 'replace' {
  let to: URL;
  try {
    to = new URL(targetHref, origin);
  } catch {
    return 'ignore';
  }
  if (to.origin !== origin) return 'ignore';
  const wsBase = wsHref(ws);
  if (to.pathname !== wsBase && !to.pathname.startsWith(`${wsBase}/`)) return 'ignore';
  if (to.pathname === wsBase && !to.searchParams.get('panel')) return 'ignore';
  const curParams = new URLSearchParams(currentSearch);
  curParams.sort();
  const toParams = new URLSearchParams(to.search);
  toParams.sort();
  if (decodeURIComponent(to.pathname) === decodeURIComponent(currentPath) && toParams.toString() === curParams.toString()) {
    return 'reopen';
  }
  return 'replace';
}

type PendingPanelState = {
  kind: 'nav' | 'close-aside';
} | null;

export function nextPendingPanelState(
  current: PendingPanelState,
  currentPath: string,
  params: Pick<URLSearchParams, 'get'>,
  expectedPath?: string,
): PendingPanelState {
  if (!current) return null;
  if (expectedPath && decodeURIComponent(expectedPath) !== decodeURIComponent(currentPath)) return null;
  const sidePane = params.get('thread') ?? params.get('panel');
  if (current.kind === 'close-aside') {
    return sidePane ? current : null;
  }
  return null;
}

export function PanelSlot({ ws, children }: { ws: string; children: React.ReactNode }) {
  const path = usePathname();
  const params = useSearchParams();
  const currentSearch = params.toString();
  const routeKey = `${path}?${currentSearch}`;
  const [closingFrom, setClosingFrom] = useState<string | null>(null);
  const [replacingFrom, setReplacingFrom] = useState<string | null>(null);
  const closing = closingFrom === routeKey;
  const replacing = replacingFrom === routeKey;
  const [pendingState, setPendingState] = useState<PendingPanelState>(null);
  const pending = pendingState?.kind ?? null;
  const sidePane = (q: Pick<URLSearchParams, 'get'>) => q.get('thread') ?? q.get('panel');

  useEffect(() => {
    setPendingState((cur) => nextPendingPanelState(cur, path, params));
  }, [path, params]);

  // On the bare canvas there is no panel yet, but we still listen: a click there (or `pushPanel`) shows the
  // skeleton at once instead of nothing until the server answers.
  useEffect(() => {
    const handleTarget = (targetHref: string, fromInsidePanel: boolean) => {
      let to: URL;
      try {
        to = new URL(targetHref, location.origin);
      } catch {
        return;
      }
      if (to.origin !== location.origin) return;
      if (to.pathname === wsHref(ws) && !to.search) {
        setReplacingFrom(null);
        setClosingFrom(routeKey);
        return;
      }
      const liveSearch = typeof window !== 'undefined' ? window.location.search : currentSearch;
      if (fromInsidePanel && isIntraChannelSideNav(path, liveSearch, to)) return;
      const action = resolveClosingPanelClick(ws, path, liveSearch, to.href, location.origin);
      if (action === 'reopen') {
        if (closing) {
          setReplacingFrom(null);
          setClosingFrom(null);
        }
      } else if (
        action === 'replace' &&
        (closing || !fromInsidePanel || decodeURIComponent(to.pathname) !== decodeURIComponent(path))
      ) {
        setReplacingFrom(routeKey);
        setClosingFrom(null);
        setPendingState({ kind: 'nav' });
      }
    };
    const onClick = (e: MouseEvent) => {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as HTMLElement).closest('a');
      if (!a || a.target === '_blank' || a.hasAttribute('download')) return;
      const fromInsidePanel = Boolean((e.target as HTMLElement).closest('.group\\/panel'));
      handleTarget(a.href, fromInsidePanel);
    };
    const onProgrammaticNav = (e: Event) => {
      const href = (e as CustomEvent<string>).detail;
      if (typeof href === 'string' && href) handleTarget(href, false);
    };
    const t = setTimeout(() => window.addEventListener('click', onClick, true));
    window.addEventListener(PANEL_NAV_EVENT, onProgrammaticNav);
    return () => {
      clearTimeout(t);
      window.removeEventListener('click', onClick, true);
      window.removeEventListener(PANEL_NAV_EVENT, onProgrammaticNav);
    };
  }, [closing, ws, path, currentSearch, routeKey]);

  useEffect(() => {
    if (!pendingState) return;
    const t = setTimeout(() => setPendingState(null), 20000);
    return () => clearTimeout(t);
  }, [pendingState]);

  if (path === wsHref(ws) && !params.get('panel') && !pending) return null;
  return (
    <div
      data-pending={pending ?? undefined}
      onClickCapture={(e) => {
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.defaultPrevented) return;
        const a = (e.target as HTMLElement).closest('a');
        if (!a || a.target === '_blank' || a.hasAttribute('download')) return;
        const to = new URL(a.href, location.href);
        if (to.origin !== location.origin) return;
        if (to.href === location.href) return void (pending === 'close-aside' && setPendingState(null));
        if (to.pathname === wsHref(ws) && !to.search) {
          setReplacingFrom(null);
          setClosingFrom(routeKey);
          return;
        }
        if (isIntraChannelSideNav(path, location.search, to)) return;
        const here = new URLSearchParams(location.search);
        const samePath = decodeURIComponent(to.pathname) === decodeURIComponent(path);
        if (samePath && sidePane(here) && !sidePane(to.searchParams)) {
          setPendingState({ kind: 'close-aside' });
        } else {
          if (!samePath && resolveClosingPanelClick(ws, path, location.search, to.href, location.origin) === 'replace') {
            setReplacingFrom(routeKey);
            setClosingFrom(null);
          }
          setPendingState({ kind: 'nav' });
        }
      }}
      className={`group/panel absolute inset-y-0 right-0 z-[60] ${closing ? 'hidden' : 'flex'} w-full border-l border-[var(--border)] bg-[var(--bg)] shadow-[0_0_60px_rgba(23,22,28,0.18)] md:w-[min(760px,calc(100%-72px))] ${pending !== 'close-aside' ? 'md:has-[aside[aria-label=Thread]]:w-[min(1180px,calc(100%-72px))]' : ''}`}
    >
      {pending && pending !== 'close-aside' && (
        <div role="progressbar" aria-label="Loading" className="panel-progress absolute inset-x-0 top-0 z-30 h-0.5" />
      )}
      <Link
        href={wsHref(ws)}
        scroll={false}
        aria-label="Close, back to the canvas"
        className="absolute top-3 -left-12 hidden size-9 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--surface)] shadow-md hover:bg-[var(--subtle)] md:inline-flex"
      >
        <Icon name="close" size={18} />
      </Link>
      {replacing ? (
        <>
          <div className="hidden">{children}</div>
          <div className="flex h-full w-full min-w-0 flex-1 flex-col bg-[var(--bg)]">
            <PanelSkeleton />
          </div>
        </>
      ) : (
        children
      )}
    </div>
  );
}
