import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: '1Gov Mail',
    short_name: '1Gov Mail',
    description: 'Government of Rwanda — secure email, calendar, and documents',
    start_url: '/mail',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#ffffff',
    theme_color: '#0F4C81',
    icons: [
      { src: '/icon0', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon1', sizes: '512x512', type: 'image/png', purpose: 'any' },
    ],
  };
}
