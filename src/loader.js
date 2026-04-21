/**
 * Remote config loader.
 *
 * Resolves the widget config from (in priority order):
 *   1. ?preview=<base64> on the host page URL  (used by the admin app)
 *   2. ?id=xxx in the <script src>             (remote CDN fetch)
 *   3. window.HOTEL_PRICE_WIDGET_CONFIG        (legacy inline config)
 *   4. throw                                   (nothing to work with)
 *
 * If remote fetch fails AND inline config exists, we fall back to inline
 * (safer than refusing to render).
 */

// Configs are served as siblings of widget.js under a "configs/" subfolder.
const CONFIGS_BASE_URL = resolveConfigsBase();

function resolveConfigsBase() {
  const scripts = document.getElementsByTagName('script');
  for (let i = scripts.length - 1; i >= 0; i--) {
    const src = scripts[i].src || '';
    if (src.includes('widget.js')) {
      return src.replace(/widget\.js(?:\?.*)?$/, '') + 'configs/';
    }
  }
  return './configs/';
}

function findSelfScript() {
  if (document.currentScript && document.currentScript.src) {
    return document.currentScript.src;
  }
  const scripts = document.getElementsByTagName('script');
  for (let i = scripts.length - 1; i >= 0; i--) {
    const src = scripts[i].src || '';
    if (src.includes('widget.js')) return src;
  }
  return null;
}

function extractIdFromScript() {
  const src = findSelfScript();
  if (!src) return null;
  try {
    const url = new URL(src);
    const id = url.searchParams.get('id');
    return id && id.trim() ? id.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Decode a base64 preview param (urlsafe, no padding) into a config object.
 * Returns null if not present or invalid.
 */
function extractPreviewConfig() {
  try {
    const params = new URLSearchParams(window.location.search);
    const encoded = params.get('preview');
    if (!encoded) return null;
    const padded = encoded + '='.repeat((4 - encoded.length % 4) % 4);
    const b64 = padded.replace(/-/g, '+').replace(/_/g, '/');
    // UTF-8-safe decode: atob returns a byte string, reinterpret as UTF-8
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const json = new TextDecoder().decode(bytes);
    return JSON.parse(json);
  } catch (err) {
    console.warn('[hotel-price-widget] Invalid preview param:', err);
    return null;
  }
}

/**
 * Normalize the raw config from GitHub into the shape the widget expects.
 * API-only since the CSV migration — if a config has legacy fields like
 * csvUrl/roomOptions, we ignore them silently.
 *
 * Critical fields for the widget to work:
 *   - apiHotelId       — the AvailPro hotel ID (used to call /api/rates)
 *   - apiCompetitorId  — the competitor ID within the screening response
 *   - channelsEnabled  — array of channel IDs to display (17=direct, 10=booking, 9=expedia)
 *   - reserveUrl       — template for the Book button
 *
 * If apiHotelId is missing, we still render the widget but in "fallback"
 * mode (just a "Best price guaranteed" message + Book button).
 */
export function normalizeConfig(raw) {
  if (!raw || typeof raw !== 'object') return null;

  return {
    // Identity
    hotelName: String(raw.hotelName || ''),
    hotelDomain: String(raw.hotelDomain || ''),
    logoUrl: String(raw.logoUrl || ''),

    // Data source (API-only)
    apiHotelId: Number.isInteger(raw.apiHotelId) ? raw.apiHotelId : null,
    apiCompetitorId: Number.isInteger(raw.apiCompetitorId) ? raw.apiCompetitorId : null,
    channelsEnabled: Array.isArray(raw.channelsEnabled) && raw.channelsEnabled.length > 0
      ? raw.channelsEnabled.map(Number).filter((n) => Number.isInteger(n))
      : [17, 10, 9],

    // Booking
    reserveUrl: String(raw.reserveUrl || ''),
    currency: String(raw.currency || 'EUR'),

    // Appearance
    position: ['bottom-right', 'bottom-left', 'top-right', 'top-left'].includes(raw.position)
      ? raw.position
      : 'bottom-right',
    size: ['small', 'medium', 'large'].includes(raw.size) ? raw.size : 'small',
    brandColor: String(raw.brandColor || '#1a1a1a'),
    backgroundColor: String(raw.backgroundColor || '#faf7f2'),

    // Languages
    enabledLocales: Array.isArray(raw.enabledLocales) && raw.enabledLocales.length > 0
      ? raw.enabledLocales
      : ['en'],
    defaultLocale: String(raw.defaultLocale || 'en'),

    // Auto-open
    autoOpenMode: ['disabled', 'time', 'scroll', 'time_or_scroll'].includes(raw.autoOpenMode)
      ? raw.autoOpenMode
      : 'disabled',
    autoOpenDelay: Number.isInteger(raw.autoOpenDelay) ? raw.autoOpenDelay : 8,
    autoOpenScrollPercent: [25, 50].includes(raw.autoOpenScrollPercent)
      ? raw.autoOpenScrollPercent
      : 50,

    // Analytics
    analytics: {
      enabled: !!(raw.analytics?.enabled),
      dataLayerName: String(raw.analytics?.dataLayerName || 'dataLayer'),
    },

    // Preview mode (admin-only, never in published configs)
    _preview: raw._preview === true,
  };
}

/**
 * Extract the preview config from a URL parameter. Used by the admin
 * iframe to pass a live form state to the widget for WYSIWYG editing.
 * Returns null if no preview param or if decoding fails.
 */
export function extractPreviewConfig() {
  try {
    const params = new URLSearchParams(window.location.search);
    const b64 = params.get('preview');
    if (!b64) return null;

    // URL-safe base64 to standard base64
    const std = b64.replace(/-/g, '+').replace(/_/g, '/');
    const pad = std.length % 4 === 0 ? '' : '='.repeat(4 - (std.length % 4));
    const binary = atob(std + pad);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const json = new TextDecoder().decode(bytes);
    return JSON.parse(json);
  } catch (err) {
    console.warn('[hpw] extractPreviewConfig failed', err);
    return null;
  }
}

export async function loadConfig() {
  // Priority 1: preview mode (admin live preview)
  const previewConfig = extractPreviewConfig();
  if (previewConfig) {
    previewConfig._hotelId = previewConfig._hotelId || 'preview';
    return normalizeConfig(previewConfig);
  }

  // Priority 2: remote config by ID
  const id = extractIdFromScript();
  if (id) {
    const url = `${CONFIGS_BASE_URL}${encodeURIComponent(id)}.json`;
    try {
      const res = await fetch(url, { credentials: 'omit' });
      if (!res.ok) throw new Error(`HTTP ${res.status} fetching config ${id}`);
      const raw = await res.json();
      raw._hotelId = id;
      return normalizeConfig(raw);
    } catch (err) {
      if (window.HOTEL_PRICE_WIDGET_CONFIG) {
        console.warn(
          `[hotel-price-widget] Remote config '${id}' failed, falling back to inline.`,
          err
        );
        return normalizeConfig(window.HOTEL_PRICE_WIDGET_CONFIG);
      }
      throw err;
    }
  }

  // Priority 3: inline config
  if (window.HOTEL_PRICE_WIDGET_CONFIG) {
    return normalizeConfig(window.HOTEL_PRICE_WIDGET_CONFIG);
  }

  // Priority 4: nothing
  throw new Error(
    'No config found. Load widget.js with ?id=YOUR_ID or set window.HOTEL_PRICE_WIDGET_CONFIG before loading.'
  );
}