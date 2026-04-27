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

let configRef = null;
let cachedUid = null;

/**
 * Wire up the tracker. Call once from Widget mount with the resolved
 * config. Endpoint resolution priority:
 *   1. config.trackerEndpoint        (per-hotel override)
 *   2. window.HPW_TRACKER_ENDPOINT   (page-level override / dev)
 *   3. null → tracker stays inert (no requests fired)
 */
export function initTracker(config) {
  configRef = config || null;
}

function endpoint() {
  if (configRef?.trackerEndpoint) return configRef.trackerEndpoint;
  if (typeof window !== 'undefined' && window.HPW_TRACKER_ENDPOINT) {
    return window.HPW_TRACKER_ENDPOINT;
  }
  return null;
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
 * a cookie before consent).
 */
export function getOrCreateUid() {
  if (!consentGranted()) return null;
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
 * Fire an event. No-ops silently when consent is not granted, the
 * tracker endpoint is not configured, or the browser blocks the
 * request — we do not bubble errors up to the widget.
 */
export function track(event, payload) {
  if (!consentGranted()) return;
  const url = endpoint();
  if (!url) return;
  const uid = getOrCreateUid();
  if (!uid) return;

  const hotelId = configRef?._hotelId || configRef?.hotelName || null;
  if (!hotelId) return;

  const body = JSON.stringify({
    uid,
    hotelId,
    event,
    clientTs: Date.now(),
    payload: {
      pageUrl: typeof location !== 'undefined' ? location.href : null,
      referrer: typeof document !== 'undefined' ? document.referrer : null,
      ...(payload && typeof payload === 'object' ? payload : {}),
    },
  });

  try {
    // sendBeacon is preferred: it queues the request even after the page
    // starts unloading (which is exactly when many of our events fire).
    if (
      typeof navigator !== 'undefined' &&
      typeof navigator.sendBeacon === 'function'
    ) {
      const blob = new Blob([body], { type: 'application/json' });
      const ok = navigator.sendBeacon(url, blob);
      if (ok) return;
    }
    // Fallback: keepalive fetch lets the request outlive the page too.
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
      credentials: 'omit',
    }).catch(() => {});
  } catch {
    // Swallow — the widget must never be broken by tracking failures.
  }
}
