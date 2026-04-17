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

function normalizeConfig(raw) {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Config is not an object');
  }
  return {
    position: raw.position || 'bottom-right',
    csvUrl: raw.csvUrl || '',
    roomOptions: Array.isArray(raw.roomOptions) ? raw.roomOptions : [],
    default_room_id: raw.default_room_id || (raw.roomOptions?.[0]?.id || ''),
    reserveUrl: raw.reserveUrl || '#',
    currency: raw.currency || 'EUR',
    locale: raw.locale || '',
    brandColor: raw.brandColor || '#1a1a1a',
    backgroundColor: raw.backgroundColor || '#faf7f2',
    logoUrl: raw.logoUrl || '',
    hotelName: raw.hotelName || '',
    enabledLocales: Array.isArray(raw.enabledLocales) ? raw.enabledLocales : [],
    defaultLocale: raw.defaultLocale || 'en',
    channelLabels: raw.channelLabels || {},
    analytics: {
      enabled: !!(raw.analytics && raw.analytics.enabled),
      dataLayerName: (raw.analytics && raw.analytics.dataLayerName) || 'dataLayer',
      eventPrefix: (raw.analytics && raw.analytics.eventPrefix) || 'hotel_widget_',
    },
    _hotelId: raw._hotelId || null,
  };
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