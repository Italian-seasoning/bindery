import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

// Hosted on GitHub Pages at https://italian-seasoning.github.io/bindery/.
// With a custom domain later, set `site` to that domain and `base` to '/'.
export default defineConfig({
  site: 'https://italian-seasoning.github.io',
  base: '/bindery',
  integrations: [sitemap()],
  prefetch: { prefetchAll: true, defaultStrategy: 'hover' },
  build: { inlineStylesheets: 'auto' },
});
