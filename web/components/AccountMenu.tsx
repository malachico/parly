'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { Avatar } from '@/components/Avatar';
import { Icon } from '@/components/Icon';
import { startTour } from '@/components/Tour';
import type { MenuWorkspace } from '@/lib/menuWorkspace';
import { forgetLive } from '@/lib/live';
import { devAppsHref, wsHref } from '@/lib/routes';
import { credits } from '@/lib/labels';
import { plural } from '@/lib/plural';

export type { MenuWorkspace };

/** Shared native disclosure: one canvas menu at a time, dismissed by navigation, Escape or an outside click. */
export function CanvasMenu({ label, summary, children, end = false, tour }: { label: string; summary: React.ReactNode; children: React.ReactNode; end?: boolean; tour?: string }) {
  const box = useRef<HTMLDetailsElement>(null);
  const path = usePathname();
  const params = useSearchParams();
  useEffect(() => {
    const close = () => box.current?.removeAttribute('open');
    const onPointer = (e: PointerEvent) => !box.current?.contains(e.target as Node) && close();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !box.current?.open) return;
      e.preventDefault();
      e.stopPropagation();
      close();
      box.current?.querySelector('summary')?.focus();
    };
    document.addEventListener('pointerdown', onPointer, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer, true);
      document.removeEventListener('keydown', onKey);
    };
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: path/params are the re-run trigger, not read in the body — close the open menu on any route change
  useEffect(() => box.current?.removeAttribute('open'), [path, params]);
  return (
    <details ref={box} name="canvas-menu" data-tour-group className="relative min-w-0">
      <summary aria-label={label} data-tour={tour} data-tour-trigger className="flex h-9 min-w-9 cursor-pointer list-none items-center justify-center gap-1.5 rounded-[9px] px-1.5 text-sm font-semibold hover:bg-[var(--subtle)] focus-visible:outline-2 focus-visible:outline-[var(--accent)] [&::-webkit-details-marker]:hidden">
        {summary}
      </summary>
      <div onClick={(e) => {
        const control = (e.target as HTMLElement).closest('a,button');
        if (control && control.getAttribute('role') !== 'radio' && !control.hasAttribute('aria-expanded')) box.current?.removeAttribute('open');
      }} className={`fixed top-[66px] right-4 left-4 z-50 flex max-h-[min(70dvh,560px)] flex-col sm:absolute sm:top-full ${end ? 'sm:right-0 sm:left-auto' : 'sm:left-0 sm:right-auto'} sm:mt-2 sm:w-[300px] overflow-y-auto rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-1.5 shadow-[0_18px_40px_rgba(23,22,28,0.16)]`}>
        {children}
      </div>
    </details>
  );
}

const row = 'flex min-h-9 items-center gap-2.5 rounded-lg px-2.5 text-sm hover:bg-[var(--subtle)]';

/** Workspace navigation and tools stay separate from the viewer's personal account. */
export function WorkspaceMenu({ ws, workspaceName, workspaces }: { ws: string; workspaceName: string; workspaces: MenuWorkspace[] }) {
  const live = workspaces.filter((w) => !w.archived || w.id === ws);
  const spaces = live.filter((w) => !w.room);
  // ponytail: a deleted app's rooms (appId, no app) show nowhere in the menu; they stay reachable by link.
  const rooms = live.filter((w) => w.room && !w.room.appId).sort((a, b) => Number(!!b.room!.needsSetup) - Number(!!a.room!.needsSetup));
  // An app can open a room per user: one row per app, its rooms listed under the app in Developers.
  const apps = new Map<string, { app: NonNullable<NonNullable<MenuWorkspace['room']>['app']>; count: number }>();
  for (const w of live) if (w.room?.app) apps.set(w.room.app.id, { app: w.room.app, count: (apps.get(w.room.app.id)?.count ?? 0) + 1 });
  const here = workspaces.find((w) => w.id === ws);
  return (
    <CanvasMenu label={`Workspace: ${workspaceName}`} tour="workspace" summary={<><span className="min-w-0 truncate">{workspaceName}</span><Icon name="chevron-down" size={14} className="shrink-0" /></>}>
      {here?.room?.needsSetup && <Link href={`/rooms/${encodeURIComponent(ws)}/side`} className={`${row} text-[var(--accent)]`}>Set up your side</Link>}
      <div className="px-2.5 py-2 text-[11px] font-semibold text-[var(--muted)] uppercase">Workspaces</div>
      {spaces.map((w) => <Link key={w.id} href={wsHref(w.id)} aria-current={w.id === ws ? 'page' : undefined} className={row}><span className="min-w-0 flex-1 truncate">{w.public ? '🌐 ' : ''}{w.name}{w.archived ? ' (archived)' : ''}</span>{w.id === ws && <Icon name="check" size={16} />}</Link>)}
      <Link href={wsHref(ws, { workspace: 'new' })} scroll={false} className={row}><Icon name="plus" size={16} />New workspace</Link>
      <div className="px-2.5 pt-3 pb-1 text-[11px] font-semibold text-[var(--muted)] uppercase">Shared rooms</div>
      {rooms.map((w) => <Link key={w.id} href={wsHref(w.id)} className={row}><span className="flex min-w-0 flex-1 flex-col"><span className="truncate">{w.name}</span><span className="truncate text-xs text-[var(--muted)]">{w.room!.needsSetup ? 'Set up your side' : w.room!.others.length ? `with ${w.room!.others.join(', ')}` : 'Waiting for the other side'}</span></span></Link>)}
      {[...apps.values()].map(({ app, count }) => <Link key={app.id} href={`${devAppsHref(app.workspaceId)}#app-${app.id}`} className={row}><span className="min-w-0 flex-1 truncate">{app.name}</span><span className="shrink-0 text-xs text-[var(--muted)]">{plural(count, 'room', 'rooms')}</span></Link>)}
      <Link href="/rooms/new" className={row}><Icon name="plus" size={16} />New shared room</Link>
      <div className="my-1.5 border-t border-[var(--border)]" />
      <Link href={wsHref(ws, { panel: 'workspace' })} data-tour="workspace-settings" className={row}><Icon name="info" size={16} />Workspace settings & members</Link>
    </CanvasMenu>
  );
}

/** Personal settings, billing and sign out. */
export function AccountMenu({ me, logout, tour = true, billing }: { me: { id: string; name: string; avatar?: string; admin?: boolean }; logout: () => Promise<void>; tour?: boolean; billing?: { plan: 'free' | 'pro' | 'team' | 'enterprise'; leftUsd: number } }) {
  const plan = billing && `${billing.plan[0].toUpperCase()}${billing.plan.slice(1)}`;
  const planLine = billing && `${plan} · ${credits(billing.leftUsd)} credits`;
  return (
    <CanvasMenu
      label={`${me.name}: your account${planLine ? `, ${planLine}` : ''}`}
      tour="account"
      summary={
        <Avatar who={{ ...me, kind: 'human' }} className="size-8" />
      }
    >
      <div className="flex items-center gap-2.5 px-2.5 py-2">
        <Avatar who={{ ...me, kind: 'human' }} className="size-9 shrink-0" />
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-sm font-semibold">{me.name}</span>
          {billing && <span className="truncate text-xs text-[var(--muted)]">{credits(billing.leftUsd)} credits</span>}
        </span>
      </div>
      <Link href="/account" className={row}>Your account and avatar</Link>
      <Link href="/billing" data-tour="billing" className={`${row} justify-between`}>
        Plan and billing
        {plan && <span className="rounded-full bg-[var(--accent-soft)] px-2 py-0.5 text-xs font-medium text-[var(--accent)]">{plan}</span>}
      </Link>

      <Link href="/docs" className={row}>Documentation</Link>
      {me.admin && <Link href="/admin" className={row}>Admin</Link>}
      <ThemeSwitch />
      {tour && <button type="button" onClick={startTour} className={`${row} w-full cursor-pointer text-left`}>Take the tour</button>}
      <form action={logout} onSubmit={forgetLive}><button className={`${row} w-full cursor-pointer text-left text-[var(--muted)]`}>Log out</button></form>
    </CanvasMenu>
  );
}

const THEMES = [
  ['system', 'System'],
  ['light', 'Light'],
  ['dark', 'Dark'],
] as const;

/** Light, dark, or the device's: saved in this browser, applied by the theme script in app/layout.tsx. */
function ThemeSwitch() {
  const [theme, setTheme] = useState<string>('system');
  useEffect(() => {
    try {
      setTheme(localStorage.getItem('parly.theme') ?? 'system');
    } catch {}
  }, []);
  const pick = (t: string) => {
    setTheme(t);
    try {
      if (t === 'system') localStorage.removeItem('parly.theme');
      else localStorage.setItem('parly.theme', t);
    } catch {}
    window.dispatchEvent(new Event('parly-theme'));
  };
  return (
    <div role="radiogroup" aria-label="Theme" className="mx-2.5 my-1.5 flex rounded-[10px] bg-[var(--subtle)] p-0.5 text-[13px]">
      {THEMES.map(([value, label]) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={theme === value}
          onClick={() => pick(value)}
          className={`flex-1 cursor-pointer rounded-lg px-2 py-1 ${theme === value ? 'bg-[var(--surface)] font-medium shadow-sm' : 'text-[var(--muted)]'}`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
