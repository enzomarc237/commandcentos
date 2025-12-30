import react from '@vitejs/plugin-react-swc';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

const APP_NAME = 'Remote Command Center Client';
const APP_DESCRIPTION = 'Mobile-friendly companion for the Remote Command Center.';

export default defineConfig({
  server: {
    port: 4173,
    host: '0.0.0.0',
  },
  preview: {
    port: 5174,
  },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'robots.txt'],
      manifest: {
        name: APP_NAME,
        short_name: 'RCC Remote',
        description: APP_DESCRIPTION,
        theme_color: '#0f172a',
        background_color: '#020617',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        scope: '/',
        icons: [
          {
            src: '/icons/icon.svg',
            sizes: 'any',
            type: 'image/svg+xml',
          },
          {
            src: '/icons/icon-maskable.svg',
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,ico,png,webmanifest}'],
        navigateFallback: '/index.html',
      },
    }),
  ],
});
