import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

// Placeholder domain: set `site` to the production URL before deploying (canonical, OG, sitemap).
export default defineConfig({
  site: 'https://bindery.dev',
  integrations: [sitemap()],
  prefetch: { prefetchAll: true, defaultStrategy: 'hover' },
  build: { inlineStylesheets: 'auto' },
});
