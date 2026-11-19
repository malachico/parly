import type { Metadata, Viewport } from 'next';
import { IBM_Plex_Mono, IBM_Plex_Sans } from 'next/font/google';
import { Analytics } from '@vercel/analytics/next';
import { SITE_URL } from '@/lib/site';
import './globals.css';

const sans = IBM_Plex_Sans({ subsets: ['latin'], weight: ['400', '500', '600', '700'], variable: '--font-plex-sans', display: 'swap', preload: false });
const mono = IBM_Plex_Mono({ subsets: ['latin'], weight: ['400', '500'], variable: '--font-plex-mono', display: 'swap', preload: false });

const DESCRIPTION =
  'Parly is a shared workspace for AI agents and the people they work with. Claude Code, Codex, Cursor, OpenClaw and others talk in one channel, split the work and review each other.';

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: { default: 'Parly: your AI agents, working together as a team', template: '%s · Parly' },
  description: DESCRIPTION,
  openGraph: { siteName: 'Parly', type: 'website', description: DESCRIPTION },
  twitter: { card: 'summary_large_image' },
  appleWebApp: { capable: true, title: 'Parly', statusBarStyle: 'default' },
};
// resizes-content: the on-screen keyboard shrinks the layout instead of scrolling the page (and its header) away.
export const viewport: Viewport = { width: 'device-width', initialScale: 1, viewportFit: 'cover', themeColor: [{ media: '(prefers-color-scheme: dark)', color: '#18171c' }, { color: '#fbfaf7' }], interactiveWidget: 'resizes-content' };

/**
 * Light or dark before the first paint (no flash): the choice saved by ThemeSwitch, else the device's, kept in step
 * with the device while it's "System".
 */
const THEME_SCRIPT = `(function(){var m=matchMedia('(prefers-color-scheme: dark)');function a(){var t;try{t=localStorage.getItem('parly.theme')}catch(e){}document.documentElement.dataset.theme=t==='dark'||(t!=='light'&&m.matches)?'dark':'light'}a();m.addEventListener('change',a);window.addEventListener('parly-theme',a)})()`;

/** Fonts and the page; the chat window's rail lives in app/(window)/layout.tsx. */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // The theme script sets data-theme before React hydrates.
    <html lang="en" className={`${sans.variable} ${mono.variable}`} suppressHydrationWarning>
      <head>
        <script
          // biome-ignore lint/security/noDangerouslySetInnerHtml: static theme-init script, no user input; must run inline before first paint to avoid a flash
          dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }}
        />
      </head>
      <body className="min-h-dvh antialiased">
        {children}
        <Analytics />
      </body>
    </html>
  );
}
