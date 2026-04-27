/**
 * First-party tracker for the Best Price Widget.
 *
 * Sends a small set of events to a backend (BigQuery via the admin
 * server) so we can measure widget usage independently from the
 * host page's GTM/dataLayer setup. Three guarantees:
 *
 *   1. Consent-gated. Nothing is read or written until consent is
 *      explicitly granted via window.HPW_TRACKER_CONSENT === true
 *      (set by a GTM tag that fires after the user accepts cookies).
 *   2. First-party only. Cookie is set on the host page's own domain
 *      (no third-party cookie, no cross-site identifier).
 *   3. Fire-and-forget. Uses navigator.sendBeacon when available so
 *      events survive page unload; falls back to keepalive fetch.
 *
 * The cookie name is "hpw_uid", lifetime 6 months, opaque random ID
 * (no PII, no IP, no fingerprinting). Reset by the user via normal
 * cookie management.
 */

const COOKIE_NAME = 'hpw_uid';
const COOKIE_TTL_DAYS = 183; // ~6 months

// Endpoint is fixed at build time via VITE_TRACKER_ENDPOINT (read by
// Vite at compile time and inlined into the bundle). For local dev or
// to override per page without rebuilding, set window.HPW_TRACKER_ENDPOINT
// before the widget loads. Per-hotel toggling is done via the
// `trackerEnabled` boolean on the config — the URL never travels in
// the JSON published to GitHub.
const BUILT_IN_ENDPOINT = import.meta.env?.VITE_TRACKER_ENDPOINT || null;

let configRef = null;
let cachedUid = null;

/**
 * Wire up the tracker. Call once from Widget mount with the resolved
 * config.
 */
export function initTracker(config) {
  configRef = config || null;
}

function endpoint() {
  if (typeof window !== 'undefined' && window.HPW_TRACKER_ENDPOINT) {
    return window.HPW_TRACKER_ENDPOINT;
  }
  return BUILT_IN_ENDPOINT;
}

function trackingEnabled() {
  return !!configRef?.trackerEnabled;
}

/**
 * Consent gate. Returns true only if the host page has explicitly
 * granted analytics consent. The expected pattern is a GTM tag that
 * sets `window.HPW_TRACKER_CONSENT = true` after the user accepts —
 * see docs/TRACKER.md.
 */
export function consentGranted() {
  return typeof window !== 'undefined' && window.HPW_TRACKER_CONSENT === true;
}

function readCookie(name) {
  if (typeof document === 'undefined') return null;
  const prefix = `${name}=`;
  for (const c of document.cookie.split(';')) {
    const trimmed = c.trim();
    if (trimmed.startsWith(prefix)) return trimmed.slice(prefix.length);
  }
  return null;
}

function writeCookie(name, value, days) {
  if (typeof document === 'undefined') return;
  const exp = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toUTCString();
  // SameSite=Lax keeps the cookie on top-level navigations (the user
  // clicking Book Now opens the booking engine on a different domain;
  // we want the next widget load on the host page to still see it).
  document.cookie =
    `${name}=${encodeURIComponent(value)}; Expires=${exp}; Path=/; SameSite=Lax`;
}

function generateUid() {
  // crypto.randomUUID is widely supported in modern browsers; fall back
  // to a hex random for older ones. 32 hex chars = 128 bits of entropy.
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID().replace(/-/g, '');
  }
  const buf = new Uint8Array(16);
  (crypto?.getRandomValues || ((b) => b.fill(0)))(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

// Cross-domain linker: if the host hotel page passed an hpw_uid via
// the URL (the booking-engine flow does this — see Widget.jsx where
// the Book href is decorated), pick it up and adopt it as the local
// identity. Lets a single visitor keep the same uid across the host
// page and the booking-engine domain even though cookies are
// per-origin. Returns null if no valid uid is on the URL.
function readUidFromUrl() {
  if (typeof location === 'undefined') return null;
  try {
    const p = new URLSearchParams(location.search);
    const u = p.get('hpw_uid');
    if (!u) return null;
    // Validate shape — same constraints as the server uid check.
    // 8-64 chars, hex (or hex-with-dashes for legacy UUID-style).
    if (u.length < 8 || u.length > 64) return null;
    if (!/^[a-f0-9-]+$/i.test(u)) return null;
    return u;
  } catch {
    return null;
  }
}

/**
 * Returns the user's persistent ID, creating + persisting it on first
 * call. Returns null when consent has not been granted (we never set
 * a cookie before consent) or when tracking is not enabled for this
 * hotel.
 *
 * Resolution order:
 *   1. cached value (already resolved in this page)
 *   2. ?hpw_uid in the URL — cross-domain handoff. Adopted as the
 *      local cookie so the visitor is identified the same way on the
 *      host hotel page and on the booking-engine domain.
 *   3. existing first-party cookie on this origin
 *   4. fresh random uid
 */
export function getOrCreateUid() {
  if (!consentGranted() || !trackingEnabled()) return null;
  if (cachedUid) return cachedUid;

  const fromUrl = readUidFromUrl();
  if (fromUrl) {
    cachedUid = fromUrl;
    writeCookie(COOKIE_NAME, cachedUid, COOKIE_TTL_DAYS);
    return cachedUid;
  }

  const existing = readCookie(COOKIE_NAME);
  if (existing) {
    cachedUid = existing;
    return cachedUid;
  }

  cachedUid = generateUid();
  writeCookie(COOKIE_NAME, cachedUid, COOKIE_TTL_DAYS);
  return cachedUid;
}

/**
 * Read-only variant — returns the cached uid, the cookie, or a uid
 * already on the URL (cross-domain handoff still in flight) without
 * ever writing. Safe to call during render. Used to decorate the
 * Book URL.
 */
export function peekUid() {
  if (cachedUid) return cachedUid;
  if (!consentGranted() || !trackingEnabled()) return null;
  const existing = readCookie(COOKIE_NAME);
  if (existing) {
    cachedUid = existing;
    return cachedUid;
  }
  const fromUrl = readUidFromUrl();
  return fromUrl || null;
}

/**
 * Fire an event. No-ops silently when consent is not granted,
 * tracking is not enabled for this hotel, the endpoint is not
 * configured, or the browser blocks the request — we never bubble
 * errors up to the widget.
 *
 * `data` is a free-form key/value object. Three keys get lifted to
 * top-level fields the server writes into typed BigQuery columns:
 *   - bookingId  → STRING
 *   - price      → NUMERIC
 *   - currency   → STRING (3-letter ISO uppercase)
 * Anything else stays in the JSON payload column.
 */
export function track(event, data) {
  if (!consentGranted() || !trackingEnabled()) return;
  const url = endpoint();
  if (!url) return;
  const uid = getOrCreateUid();
  if (!uid) return;

  const hotelId = configRef?._hotelId || configRef?.hotelName || null;
  if (!hotelId) return;

  const safe = data && typeof data === 'object' ? data : {};
  const body = {
    uid,
    hotelId,
    event,
    clientTs: Date.now(),
    payload: {
      pageUrl: typeof location !== 'undefined' ? location.href : null,
      referrer: typeof document !== 'undefined' ? document.referrer : null,
      ...safe,
    },
  };
  if (typeof safe.bookingId === 'string') body.bookingId = safe.bookingId;
  if (typeof safe.price === 'number') body.price = safe.price;
  if (typeof safe.currency === 'string') body.currency = safe.currency;

  const json = JSON.stringify(body);

  try {
    // sendBeacon is preferred: it queues the request even after the page
    // starts unloading (which is exactly when many of our events fire).
    if (
      typeof navigator !== 'undefined' &&
      typeof navigator.sendBeacon === 'function'
    ) {
      const blob = new Blob([json], { type: 'application/json' });
      const ok = navigator.sendBeacon(url, blob);
      if (ok) return;
    }
    // Fallback: keepalive fetch lets the request outlive the page too.
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: json,
      keepalive: true,
      credentials: 'omit',
    }).catch(() => {});
  } catch {
    // Swallow — the widget must never be broken by tracking failures.
  }
}

/**
 * Expose track on a stable global so host pages (a GTM Custom HTML
 * tag, the booking flow's confirmation page, etc.) can fire custom
 * events without owning their own copy of the cookie / endpoint
 * plumbing. Idempotent — safe to call on every Widget mount.
 *
 * Also drains the pre-mount queue: if the host page installed a stub
 *   window.HPW = { q: [], track: function() { HPW.q.push(arguments) } };
 * any track() calls made before the widget bundle arrived (e.g. a
 * GTM tag firing on a fast SPA navigation) get replayed once the
 * real implementation is wired up. Standard analytics-SDK pattern.
 */
export function exposeOnWindow() {
  if (typeof window === 'undefined') return;
  const existing = window.HPW || {};
  const queued = Array.isArray(existing.q) ? existing.q.slice() : [];
  window.HPW = Object.assign(existing, { track });
  delete window.HPW.q;
  for (const args of queued) {
    try {
      track.apply(null, Array.from(args));
    } catch {
      // Drain failures must not break the widget.
    }
  }
}
