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
    console.log('[HPW DEBUG]   creating window[' + dlName + ']');
    window[dlName] = window[dlName] || [];
    console.log('[HPW DEBUG]   window[' + dlName + '] is now:', window[dlName]);
  } else {
    console.log('[HPW DEBUG]   NOT creating dataLayer because enabled() is falsy');
  }
}

function enabled() {
  return configRef && configRef.analytics && configRef.analytics.enabled;
}

function push(eventName, payload = {}) {
  if (!enabled()) return;
  const dlName = configRef.analytics.dataLayerName || 'dataLayer';
  const prefix = configRef.analytics.eventPrefix || 'hotel_widget_';

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

export function autoOpened(hotelId, delaySeconds) {
    pushEvent('auto_opened', {
      hotel_id: hotelId,
      delay_seconds: delaySeconds,
    });
  },

export function trackRoomChanged(roomId, roomName) {
  push('room_changed', { room_id: roomId, room_name: roomName });
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