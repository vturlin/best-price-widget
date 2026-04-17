import React from 'react';
import { createRoot } from 'react-dom/client';
import Widget from './Widget.jsx';

/**
 * Auto-mount on DOM ready. Finds #price-widget (documented target) or falls
 * back to data-hotel-price-widget attribute for advanced users.
 *
 * Style isolation: we mount into Shadow DOM so host-page CSS cannot reach
 * our components (aggressive * { } resets on hotel sites are common and
 * would otherwise destroy the widget). CSS is fetched at runtime and
 * injected into the shadow root — it never touches the host's document.
 *
 * Why fetch instead of inline? Inlining CSS into the JS bundle adds ~11kB
 * to every page load, and the bytes aren't cacheable separately. Fetching
 * widget.css from the same directory as widget.js lets the CDN cache it
 * with a long TTL. The double request is a non-issue because the two files
 * load in parallel and Shadow DOM swaps the <style> in atomically.
 */

function findMountNode() {
  let node = document.getElementById('price-widget') ||
             document.querySelector('[data-hotel-price-widget]');
  if (node) return node;

  // Auto-create the mount point — this is what makes the widget embeddable
  // via GTM or any tag-management system where you can't inject arbitrary
  // HTML into the page.
  node = document.createElement('div');
  node.id = 'price-widget';
  document.body.appendChild(node);
  return node;
}

/** Find where widget.js is hosted so we can resolve widget.css next to it. */
function resolveAssetBase() {
  const scripts = document.getElementsByTagName('script');
  for (let i = scripts.length - 1; i >= 0; i--) {
    const src = scripts[i].src || '';
    if (src.includes('widget.js')) {
      return src.replace(/widget\.js(?:\?.*)?$/, '');
    }
  }
  // Fallback: current page origin
  return './';
}

async function loadCss(shadow) {
  const base = resolveAssetBase();
  const cssUrl = base + 'widget.css';
  try {
    const res = await fetch(cssUrl);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const css = await res.text();
    const style = document.createElement('style');
    style.textContent = css;
    shadow.appendChild(style);
  } catch (err) {
    console.error(
      `[hotel-price-widget] Failed to load widget.css from ${cssUrl}. ` +
      `Make sure it's deployed alongside widget.js.`,
      err
    );
  }
}

import { loadConfig } from './loader.js';

async function mount() {
  const host = findMountNode();
  if (!host) {
    console.warn(
      '[hotel-price-widget] Mount point not found. Add <div id="price-widget"></div> or let the widget auto-create it.'
    );
    return;
  }

  let config;
  try {
    config = await loadConfig();
  } catch (err) {
    console.error('[hotel-price-widget]', err.message);
    return;
  }

  if (host.shadowRoot) return;

  const shadow = host.attachShadow({ mode: 'open' });
  loadCss(shadow);

  const container = document.createElement('div');
  container.className = 'hpw-root';
  shadow.appendChild(container);

  const root = createRoot(container);
  root.render(<Widget config={config} />);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mount);
} else {
  mount();
}
