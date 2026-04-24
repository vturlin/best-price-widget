/**
 * Analytics bridge. Pushes widget interactions into the host page's
 * dataLayer (GTM-compatible). Configured via config.analytics.
 *
 * All events are prefixed (default 'hotel_widget_') and include hotel_id
 * so GTM/GA can filter across deployments.
 */

let configRef = null;
let lastSavingsKey = null;

export function initAnalytics(config) {
  configRef = config;
  lastSavingsKey = null;

  if (enabled()) {
    const dlName = config.analytics.dataLayerName || 'dataLayer';
    window[dlName] = window[dlName] || [];
  }
}

function enabled() {
  return configRef && configRef.analytics && configRef.analytics.enabled;
}

function push(eventName, payload = {}) {
  if (!enabled()) return;
  const dlName = configRef.analytics.dataLayerName || 'dataLayer';
  const prefix =  'dedge_widget_';

  window[dlName] = window[dlName] || [];
  window[dlName].push({
    event: prefix + eventName,
    hotel_id: configRef._hotelId || null,
    ...payload,
  });
}

export function trackOpened() {
  push('opened');
}

export function trackDatesChanged(checkIn, checkOut, nights) {
  push('dates_changed', { check_in: checkIn, check_out: checkOut, nights });
}

export function trackSavingsShown({ roomId, nights, directPrice, savings, vsChannel }) {
  // Dedupe: same state doesn't re-fire the event
  const key = `${roomId}|${nights}|${savings}|${vsChannel}`;
  if (key === lastSavingsKey) return;
  lastSavingsKey = key;

  push('savings_shown', {
    room_id: roomId,
    nights,
    direct_price: directPrice,
    savings,
    vs_channel: vsChannel,
    currency: configRef.currency,
  });
}

export function trackReserveClicked({ roomId, nights, directPrice, checkIn, checkOut }) {
  push('reserve_clicked', {
    room_id: roomId,
    nights,
    direct_price: directPrice,
    check_in: checkIn,
    check_out: checkOut,
    currency: configRef.currency,
  });
}

// ─── Session-level dismissal ────────────────────────────────────────
// Remembers that the user closed the widget in this session. Used by
// the auto-open logic to respect the user's intent and not reopen
// repeatedly. Cleared when the tab is closed (sessionStorage).

const DISMISSED_KEY_PREFIX = 'hpw_dismissed_';

export function isDismissedThisSession(hotelId) {
  try {
    return !!sessionStorage.getItem(DISMISSED_KEY_PREFIX + hotelId);
  } catch {
    return false;
  }
}

export function markDismissedThisSession(hotelId) {
  try {
    sessionStorage.setItem(DISMISSED_KEY_PREFIX + hotelId, '1');
  } catch {
    // sessionStorage might be unavailable (private mode, SSR); silently ignore
  }
}