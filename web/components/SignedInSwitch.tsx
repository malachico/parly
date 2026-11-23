'use client';

import { useEffect, useState } from 'react';

// One request for the header and footer islands mounting together; forgotten after, so signing in/out (a soft
// navigation, not a reload) is picked up. The last answer is kept so a later page shows it at once, no "Sign in" flash.
let known: boolean | undefined;
let session: Promise<boolean> | undefined;
const signedIn = () =>
  (session ??= fetch('/api/session', { cache: 'no-store' })
    .then((r) => r.json() as Promise<{ signedIn?: boolean }>)
    .then((b) => (known = Boolean(b.signedIn)), () => known ?? false)
    .finally(() => {
      session = undefined;
    }));

/** Whether this browser is signed in, per /api/session; undefined until the tab's first answer. */
export function useSignedIn(): boolean | undefined {
  const [inn, setIn] = useState(known);
  useEffect(() => {
    let live = true;
    void signedIn().then((v) => live && setIn(v));
    return () => {
      live = false;
    };
  }, []);
  return inn;
}

/**
 * `signedIn` or `signedOut` per /api/session (keeps the site pages static). Before the tab's first answer, `signedOut`
 * holds its place invisibly, so the header neither jumps nor flashes "Sign in" at someone signed in.
 */
export function SignedInSwitch({ signedIn: whenIn = null, signedOut = null }: { signedIn?: React.ReactNode; signedOut?: React.ReactNode }) {
  const inn = useSignedIn();
  if (inn === undefined) return <span className="invisible contents">{signedOut}</span>;
  return <>{inn ? whenIn : signedOut}</>;
}
