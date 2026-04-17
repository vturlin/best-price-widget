/**
 * ============================================================
 *  HOTEL PRICE WIDGET — CONFIGURATION
 * ============================================================
 *
 *  This is the only file a hotelier typically needs to edit.
 *  All values below are consumed at runtime by widget.js.
 *
 *  IMPORTANT: This file must be loaded BEFORE widget.js:
 *
 *    <div id="price-widget"></div>
 *    <script src="https://your-cdn/config.js"></script>
 *    <script src="https://your-cdn/widget.js"></script>
 *    <link  rel="stylesheet" href="https://your-cdn/widget.css" />
 *
 *  The script attaches to window.HOTEL_PRICE_WIDGET_CONFIG.
 * ============================================================
 */

window.HOTEL_PRICE_WIDGET_CONFIG = {
  /* ----- Positioning ------------------------------------------------- */
  // Where the widget floats on the host page.
  // One of: 'bottom-right' | 'bottom-left' | 'center-left' | 'center-right'
  position: 'bottom-left',

  /* ----- Data source ------------------------------------------------- */
  // Google Sheet published as CSV. In Google Sheets:
  //   File > Share > Publish to web > select sheet > CSV > Publish
  // Then paste the resulting URL here. It must be publicly accessible.
  //
  // Expected columns (header row, exact casing):
  //   date, room_id, room_name, direct, booking, expedia, trivago, hotels_com
  //
  // Additional OTA columns are auto-detected — any column not in the
  // reserved set {date, room_id, room_name, direct} is treated as an OTA.
  // One row per (date, room_id). Dates in ISO format: YYYY-MM-DD.
  // For the demo we point at a bundled sample CSV. In production, replace
  // with your Google Sheets publish URL (see instructions above).
  csvUrl: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vRckcXCc9drXANLvWi95QqIcOQlzvj9hMibxM1bLa6zCO-BF5bbcY-LuKTYiMoPWaWWsn9I7iiBr143/pub?gid=592861194&single=true&output=csv',

  /* ----- Rooms ------------------------------------------------------- */
  // Room options shown in the dropdown. `id` must match room_id in the sheet.
  roomOptions: [
    { id: 'deluxe-king',   name: 'Deluxe King Room'    },
    { id: 'superior-twin', name: 'Superior Twin Room'  },
    { id: 'junior-suite',  name: 'Junior Suite'        },
    { id: 'terrace-suite', name: 'Terrace Suite'       },
  ],
  default_room_id: 'deluxe-king',

  /* ----- Booking engine --------------------------------------------- */
  // Reserve CTA target. Supports {checkIn}, {checkOut}, {roomId} placeholders
  // which the widget substitutes with the selected values (ISO dates).
  reserveUrl: 'https://www-secure-hotel-booking.staging.d-edge.app/d-edge/hotel-le-charles-quint-/247C/fr-FR/RoomSelection?arrivalDate={checkIn}&departureDate={checkOut}&room={roomId}',

  /* ----- Branding --------------------------------------------------- */
  currency:   'EUR',          // ISO 4217 — 'EUR', 'USD', 'GBP', 'JPY', etc.
  locale:     '',        // BCP 47 — controls number & date formatting
  brandColor: '#1a1a1a',      // Primary accent. Text/buttons derive from this.
  logoUrl:    '',             // Optional. Leave '' to show hotel name instead.
  hotelName:  'Hôtel Marquise',
   /* ----- Internationalization --------------------------------------- */
  // Which locales the widget is allowed to use for this hotel. The widget
  // will auto-detect language from <html lang> or navigator.language, but
  // will only apply it if the primary subtag is in this list. An empty
  // array or omitted field means "all supported languages".
  //
  // Supported: en, fr, es, de, it, pt, nl, pl, ru, cs, sv, da, no, fi,
  //            el, tr, zh, ja, ko, ar
  enabledLocales: ['en', 'fr', 'es', 'de', 'it','jp'],

  // Fallback when the detected language isn't in enabledLocales, or when
  // locale JSON fails to load.
  defaultLocale: 'en',


  /* ----- OTA display labels ----------------------------------------- */
  // Map raw CSV column names to pretty labels. Unmapped columns use
  // Title Case of the column name (e.g. `hotels_com` → `Hotels.com`).
  channelLabels: {
    booking:    'Booking.com',
    expedia:    'Expedia',
    trivago:    'Trivago',
    hotels_com: 'Hotels.com',
    agoda:      'Agoda',
    airbnb:     'Airbnb',
  },
};
