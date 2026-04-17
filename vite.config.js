import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

// Build produces two artifacts the hotelier embeds:
//   dist/widget.js   - self-contained IIFE that auto-mounts into #price-widget
//   dist/widget.css  - scoped styles, fetched at runtime and injected into Shadow DOM
//
// React + ReactDOM are bundled into widget.js. This is deliberate: hoteliers
// paste one <script> tag into a CMS (Wix/WordPress/bespoke). Assuming a peer
// React install on an arbitrary marketing site is a footgun.
//
// The CSS is emitted as a sibling file — NOT inlined into JS — so the CDN
// can cache it separately with a long TTL. widget.js fetches it at runtime
// and injects it into the Shadow DOM (see src/embed.jsx).
  export default defineConfig({
    plugins: [
      react(),
      {
        name: 'emit-widget-css',
        apply: 'build',
        async generateBundle() {
          const fs = await import('node:fs');
          const path = await import('node:path');
          const css = fs.readFileSync(
            path.resolve(__dirname, 'src/widget.css'),
            'utf8'
          );
          this.emitFile({
            type: 'asset',
            fileName: 'widget.css',
            source: css,
          });
        },
      },
    ],
    // 👇 AJOUTEZ CE BLOC
    define: {
      'process.env.NODE_ENV': JSON.stringify('production'),
    },
  build: {
    lib: {
      entry: resolve(__dirname, 'src/embed.jsx'),
      name: 'HotelPriceWidget',
      formats: ['iife'],
      fileName: () => 'widget.js',
    },
    rollupOptions: {
      output: {
        extend: true,
      },
    },
    cssCodeSplit: false,
    sourcemap: false,
    minify: 'esbuild',
    target: 'es2018',
  },
  server: {
    port: 5173,
    open: '/demo.html',
  },
});
