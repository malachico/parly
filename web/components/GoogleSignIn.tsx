'use client';

import Script from 'next/script';
import { useEffect, useRef, useState, useTransition } from 'react';
import { googleLogin } from '@/lib/actions';

type Gis = {
  accounts: {
    id: {
      initialize(opts: { client_id: string; callback: (r: { credential: string }) => void; ux_mode?: 'popup' }): void;
      renderButton(el: HTMLElement, opts: Record<string, unknown>): void;
    };
  };
};
declare global {
  interface Window {
    google?: Gis;
  }
}

/**
 * The "Sign in with Google" button (Google Identity Services). The ID token goes to a server action, never to client JS storage.
 * `next` is where to land afterwards (a path on this site), e.g. back on an agent's consent page.
 */
export function GoogleSignIn({ clientId, next }: { clientId: string; next?: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [loaded, setLoaded] = useState(false);
  const [pending, start] = useTransition();

  useEffect(() => {
    const gis = window.google;
    if (!loaded || !gis || !box.current) return;
    gis.accounts.id.initialize({
      client_id: clientId,
      ux_mode: 'popup',
      callback: (r) => start(() => googleLogin(r.credential, next)),
    });
    gis.accounts.id.renderButton(box.current, {
      type: 'standard',
      theme: 'outline',
      size: 'large',
      text: 'continue_with',
      shape: 'pill',
      width: Math.min(box.current.clientWidth || 320, 400),
    });
  }, [loaded, clientId, next]);

  return (
    <>
      <Script src="https://accounts.google.com/gsi/client" strategy="afterInteractive" onReady={() => setLoaded(true)} />
      <div ref={box} className="flex h-11 w-full items-center justify-center" aria-busy={pending} />
      {pending && <p className="muted text-center">Signing you in…</p>}
    </>
  );
}
