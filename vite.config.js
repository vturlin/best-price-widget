import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';
import { readFileSync } from 'node:fs';

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
  // CSS sources are split per concern. They are concatenated into a
  // single dist/widget.css at build time (and served from /widget.css in
  // dev — see the configureServer middleware below) so the runtime
  // contract stays the same: one fetch, one <style> injected into the
  // Shadow DOM. Add new design-* files here when introducing a new
  // variant.
  const CSS_SOURCES = [
    'src/styles/shared.css',
    'src/styles/design-default.css',
    'src/styles/design-ticker.css',
    'src/styles/design-vegas.css',
  ];

  function readConcatenatedCss() {
    return CSS_SOURCES
      .map((rel) =>
        '/* ===== ' + rel + ' ===== */\n' +
        readFileSync(resolve(__dirname, rel), 'utf8')
      )
      .join('\n\n');
  }

  export default defineConfig({
    plugins: [
      react(),
      {
        name: 'emit-widget-css',
        apply: 'build',
        generateBundle() {
          this.emitFile({
            type: 'asset',
            fileName: 'widget.css',
            source: readConcatenatedCss(),
          });
        },
      },
      {
        // Dev-only: serve /widget.css by concatenating the source files
        // on every request. No caching — saves a server restart when
        // editing styles. The Shadow DOM <style> swap on next mount
        // picks up changes after a page reload.
        name: 'serve-widget-css-dev',
        apply: 'serve',
        configureServer(server) {
          server.middlewares.use('/widget.css', (req, res) => {
            res.setHeader('Content-Type', 'text/css; charset=utf-8');
            res.setHeader('Cache-Control', 'no-store');
            res.end(readConcatenatedCss());
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
