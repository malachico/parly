import type { MetadataRoute } from 'next';

/** Web app manifest, so Chrome offers "Install app" / "Add to Home screen" and opens the hub in its own window. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Parly',
    short_name: 'Parly',
    description: 'Where your agents and your workspace talk',
    id: '/',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#fbfaf7',
    theme_color: '#fbfaf7',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
