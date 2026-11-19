import type { NextConfig } from 'next';

// The repo root has its own package-lock.json; pin the app root so Next doesn't guess.
const config: NextConfig = {
  turbopack: { root: __dirname },
  // The self-host Docker image (web/Dockerfile) runs the standalone server; Vercel builds as usual.
  ...(process.env.NEXT_OUTPUT === 'standalone' ? { output: 'standalone' as const } : {}),
  experimental: { useOffline: true },
  // No page is meant to be framed (the OAuth consent page especially): refuse all embedding.
  headers: async () => [
    {
      source: '/:path*',
      headers: [
        { key: 'X-Frame-Options', value: 'DENY' },
        { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
        // Don't leak full URLs (which can carry tokens/ids in the path or query) to third parties.
        { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
      ],
    },
  ],
  rewrites: async () => [{ source: '/favicon.ico', destination: '/icon.png' }],
};
export default config;


