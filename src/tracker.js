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

/**
 * Returns the user's persistent ID, creating + persisting it on first
 * call. Returns null when consent has not been granted (we never set
 * a cookie before consent) or when tracking is not enabled for this
 * hotel.
 */
export function getOrCreateUid() {
  if (!consentGranted() || !trackingEnabled()) return null;
  if (cachedUid) return cachedUid;
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
 * Read-only variant — returns the cached uid (or the cookie if any)
 * without ever writing. Safe to call during render. The widget uses
 * this to decorate the Book URL with hpw_uid so the booking-engine's
 * confirmation page can attribute the sale.
 */
export function peekUid() {
  if (cachedUid) return cachedUid;
  if (!consentGranted() || !trackingEnabled()) return null;
  const existing = readCookie(COOKIE_NAME);
  if (existing) cachedUid = existing;
  return cachedUid || null;
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
 */
export function exposeOnWindow() {
  if (typeof window === 'undefined') return;
  // Don't clobber an existing HPW namespace if one is set up by the
  // host page; just merge our methods in.
  window.HPW = Object.assign(window.HPW || {}, { track });
}
