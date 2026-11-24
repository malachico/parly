import { Landing } from '@/components/Landing';

/**
 * Home, signed out: what Parly is (the page search engines and AI assistants read). Prerendered, so no cookies here;
 * proxy.ts sends someone signed in to their workspace instead (app/(window)/home).
 */
export default function Home() {
  return (
    // The landing scrolls inside itself, so it gets the chat window's fixed-height shell (app/(window)/layout.tsx).
    <div className="app-shell relative flex h-dvh min-h-0 overflow-clip">
      <Landing />
    </div>
  );
}
