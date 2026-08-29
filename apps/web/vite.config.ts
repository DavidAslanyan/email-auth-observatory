import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// GitHub Pages serves project sites from /<repo>/, so the base must be set at
// build time. Local dev and user/org pages use '/'. configure-pages emits
// base_path without a trailing slash, which Vite needs, so normalise it.
const raw = process.env.PAGES_BASE ?? '/';
const base = raw.endsWith('/') ? raw : `${raw}/`;

export default defineConfig({
  base,
  plugins: [react()],
  build: { outDir: 'dist', sourcemap: true },
});
