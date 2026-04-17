/**
 * Remote config loader.
 *
 * Reads ?id=xxx from the widget.js <script src>, fetches the matching
 * config JSON from a CDN (jsDelivr mirroring a GitHub repo of configs),
 * normalizes it, and returns a ready-to-use config object.
 *
 * Fallback order:
 *   1. ?id in script URL → fetch remote config
 *   2. window.HOTEL_PRICE_WIDGET_CONFIG → use inline config
 *   3. throw (nothing to work with)
 *
 * If remote fetch fails AND inline config exists, we fall back to inline
 * (safer than refusing to render).
 */

// For POC: configs are served from the same directory as widget.js,
// under a "configs/" subfolder. To point at a remote CDN later,
// override this with an absolute URL.
const CONFIGS_BASE_URL = resolveConfigsBase();

function resolveConfigsBase() {
  // Find the <script> that loaded widget.js and build a sibling URL
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

  if (window.HOTEL_PRICE_WIDGET_CONFIG) {
    return normalizeConfig(window.HOTEL_PRICE_WIDGET_CONFIG);
  }

  throw new Error(
    'No config found. Load widget.js with ?id=YOUR_ID or set window.HOTEL_PRICE_WIDGET_CONFIG before loading.'
  );
}