# Best Price Widget

An embeddable React widget that hotels paste into their direct-booking site
to show visitors they have the best price compared to OTAs (Booking.com,
Expedia, Agoda, …).

The widget floats in a corner of the page, shows the direct-site price
prominently, lists OTA prices underneath with a "you save X" message, and
funnels the visitor to the hotel's own booking engine.

<p align="center"><em>One script tag. Three design variants. 20 locales bundled.</em></p>

---

## How it works

1. The hotel deploys a config JSON (e.g. `hm_demo001.json`) containing its
   AvailPro hotel ID, brand color, reserve URL template, etc.
2. The widget loads `widget.js` with a `?id=…` query param, pulls the
   matching config from `configs/<id>.json`, and resolves the visitor's
   locale.
3. On open, the widget asks the rates proxy (`hotel-widget-admin` Cloud
   Run service) for the relevant month(s) of rates, aggregates per channel
   per night, and computes savings vs the cheapest OTA.
4. Direct price is shown prominently. OTA prices appear in a comparison
   table or marquee depending on the chosen design.
5. The Book button deep-links into the hotel's booking engine with the
   selected dates substituted into a URL template.

The widget itself is static (a CDN-served IIFE bundle). The only backend
piece is the rates proxy.

---

## Quick start (hotelier)

After `widget.js` and its sibling `widget.css` and `configs/<id>.json` are
deployed to a CDN, paste this into any page:

```html
<div id="price-widget"></div>
<script async src="https://your-cdn/widget.js?id=YOUR_HOTEL_ID"></script>
```

The mount point is optional — if no `#price-widget` (or
`[data-hotel-price-widget]`) element exists, the widget auto-creates one
and appends it to `<body>`.

> **`widget.css` must sit next to `widget.js`.** The script fetches it by
> relative URL at runtime and injects it into Shadow DOM.
> **`configs/` must sit next to `widget.js`.** The script reads
> `configs/<id>.json` from the same parent directory.

For an inline config (no remote fetch, e.g. for testing), set
`window.HOTEL_PRICE_WIDGET_CONFIG = { … }` before loading `widget.js`.

---

## Configuration reference

Configs are JSON, served from `configs/<hotelId>.json` next to `widget.js`.

| Key                     | Type                          | Description                                                                       |
| ----------------------- | ----------------------------- | --------------------------------------------------------------------------------- |
| `hotelName`             | string                        | Display label. Used as the analytics fallback `hotel_id` if `_hotelId` is absent. |
| `apiHotelId`            | integer                       | AvailPro hotel ID — drives `/api/rates/<id>` calls.                               |
| `apiCompetitorId`       | integer                       | Competitor ID inside the screening response.                                      |
| `channelsEnabled`       | `number[]`                    | Channel IDs to display (defaults to `[17, 10, 9]` = direct, Booking, Expedia).    |
| `reserveUrl`            | string                        | Booking engine URL. Supports `{checkIn}` and `{checkOut}` tokens.                 |
| `currency`              | ISO 4217                      | `'EUR'`, `'USD'`, etc. Used as a display fallback when the API response omits it. |
| `widgetDesign`          | `'default'` \| `'ticker'` \| `'vegas'` | Visual variant. See "Designs" below.                                       |
| `vegasVariant`          | `'sobre'` \| `'standard'` \| `'riche'` \| `'extravagant'` | Ornament density when `widgetDesign === 'vegas'`.    |
| `position`              | `'bottom-right'` \| `'bottom-left'` \| `'center-right'` \| `'center-left'` \| `'top-right'` \| `'top-left'` | Where it floats. |
| `size`                  | `'small'` \| `'medium'` \| `'large'` | Scale factor (0.765 / 0.84 / 0.92).                                        |
| `brandColor`            | hex string                    | Primary accent. Drives the Book button + V5 wax stamp.                            |
| `toggleColor`           | hex string                    | Optional override for the closed-state seal (default design only).                |
| `backgroundColor`       | hex string                    | Panel surface color. Dark theme triggers automatically below luminance 0.5.       |
| `enabledLocales`        | `string[]`                    | Locales available to this hotel (auto-detection picks one from this list).        |
| `defaultLocale`         | string                        | Fallback when no detected locale matches.                                         |
| `autoOpenMode`          | `'disabled'` \| `'time'` \| `'scroll'` \| `'time_or_scroll'` | Auto-open trigger.                                  |
| `autoOpenDelay`         | seconds                       | Delay before time-based auto-open (default 8s).                                   |
| `autoOpenScrollPercent` | `25` \| `50`                  | Scroll-depth threshold for scroll-based auto-open.                                |
| `analytics.enabled`     | boolean                       | Push events to the host's GTM dataLayer.                                          |
| `analytics.dataLayerName` | string                      | Defaults to `'dataLayer'`.                                                        |
| `trackerEnabled`        | boolean                       | First-party event tracking (consent-gated).                                       |

See `public/configs/hm_demo001.json` for a concrete example.

---

## Designs

Three variants, switched by `widgetDesign`:

- **`default`** — Wax-seal pill in the corner. Click to reveal a V5 panel
  with a typographic wax-stamp medallion announcing the savings. Editorial
  tone.
- **`ticker`** — Full-width Bloomberg-style rail at the bottom of the
  viewport. A live OTA marquee scrolls when collapsed; clicking expands a
  dark panel with a count-down hero price. **Copy is intentionally
  English-only** — the terminal aesthetic relies on the English jargon.
- **`vegas`** — Bordeaux/gold slot-machine chassis with light bulbs and a
  "SPIN" button. Sub-variants (`vegasVariant`) tune the ornament density
  from minimal to maximal kitsch.

The default and Vegas designs are fully localized; the ticker is not (by
design — see comment in `Widget.jsx::TickerVariant`).

---

## Localization

20 locales are bundled into `widget.js` at build time (`src/locales-embedded/`):

> ar · cs · da · de · el · en · es · fi · fr · it · ja · ko · nl · no · pl · pt · ru · sv · tr · zh

Resolution order: `config.locale` (explicit) → `<html lang>` → `navigator.language` → `defaultLocale`.
Any choice that isn't in `enabledLocales` falls through.

Missing keys cascade to the English dictionary, so adding a new key in
`en.json` instantly works in every locale (with English copy) until the
others catch up. RTL is auto-enabled for Arabic and other RTL primaries.

---

## Analytics & tracking

Two independent channels:

- **GTM dataLayer** (`src/analytics.js`). Pushes four events with the
  prefix `dedge_widget_`: `opened`, `dates_changed`, `savings_shown`,
  `reserve_clicked`. Disabled by default; enable per hotel via
  `analytics.enabled`.
- **First-party tracker** (`src/tracker.js`). Sets a `hpw_uid` cookie on
  the host domain (6-month TTL, opaque random ID, no PII) and posts three
  events (`widget_loaded`, `widget_opened`, `book_clicked`) to a backend
  for BigQuery. Strictly consent-gated — nothing happens until
  `window.HPW_TRACKER_CONSENT === true`.

The Book button uses an out-of-shadow `<a>` element (light-DOM portal,
glued to the in-shadow placeholder) so GTM's cross-domain linker can see
the user's click and decorate the URL.

---

## Style isolation

The widget mounts into **Shadow DOM**. Host-page CSS can't reach inside,
the widget's styles can't leak out. This matters because hotel marketing
sites often ship aggressive global resets (`* { all: revert; }`) that
would otherwise destroy the widget's layout.

CSS is fetched from `widget.css` at runtime and injected as a single
`<style>` element inside the shadow root. The build concatenates four
sources into that one file:

```
src/styles/shared.css           Container, positioning, dark theme, react-day-picker overrides
src/styles/design-default.css   V5 stamp panel + wax-seal toggle
src/styles/design-ticker.css    Bloomberg-style ticker rail
src/styles/design-vegas.css     Slot-machine chassis + bulbs animations
```

Fonts: the V5 design loads Cormorant Garamond and Inter from Google Fonts
inside the shadow root. If your host page blocks external fonts via CSP,
self-host them and swap the `@import` in the relevant CSS file.

---

## Development

```bash
npm install
npm run dev       # Vite dev server at :5173, opens demo.html
npm run build     # Produces dist/widget.js + dist/widget.css + dist/demo.html + dist/configs/
```

The dev server serves `widget.css` on demand by concatenating the four
source files (no caching), so you can edit styles and reload without
restarting Vite.

### Project structure

```
├── src/
│   ├── embed.jsx           # Entry: Shadow DOM mount, loads CSS, hands over to Widget
│   ├── Widget.jsx          # Main component (3 design variants, StayPicker, Book button portal)
│   ├── data.js             # API rate fetching, per-night aggregation, savings math
│   ├── loader.js           # Config resolution: ?preview= / ?id= / window.HOTEL_PRICE_WIDGET_CONFIG
│   ├── i18n.js             # Locale resolution + makeT()
│   ├── analytics.js        # GTM dataLayer push (4 events)
│   ├── tracker.js          # First-party hpw_uid + 3 events to backend
│   ├── wax.js              # OKLCH math for the V5 wax-stamp palette
│   ├── locales-embedded/   # 20 JSON dicts bundled at build time
│   └── styles/             # 4 CSS sources, concatenated into dist/widget.css
├── public/
│   ├── demo.html           # Mock hotel landing page (widget injected via GTM in this flow)
│   ├── transparent.html    # Transparent host for the admin's preview iframe
│   └── configs/
│       └── hm_demo001.json # Demo hotel config
├── scripts/
│   └── postbuild.js        # Copies demo.html + configs/ into dist/
├── .github/workflows/
│   └── deploy.yml          # Builds + publishes dist/ to GitHub Pages
├── vite.config.js          # IIFE build, CSS concatenated as dist/widget.css
└── package.json
```

### Build output

```
dist/
├── widget.js     # ~140 kB min (~45 kB gzip) — React + ReactDOM + react-day-picker bundled
├── widget.css    # Injected into Shadow DOM at runtime (CDN-cacheable separately)
├── configs/      # Hotel config JSONs (one per hotelId)
└── demo.html     # Standalone demo
```

### Tech choices

- **React + ReactDOM are bundled in.** Adds ~40 kB gzip but lets the hotel
  paste a single `<script>` tag — assuming a peer React install on an
  arbitrary marketing site is a footgun.
- **react-day-picker v9** for the date range picker. Used at the boundary
  with a small local-time adapter (`parseISODateLocal`) — internal date
  math stays in UTC.
- **No build-time React import.** Vite's JSX transform handles JSX
  directly, so `embed.jsx` and `Widget.jsx` don't need
  `import React from 'react'`.

### Preview mode (admin)

When `?preview=<base64>` is present on the host URL, the widget decodes
the param as JSON and uses it as the live config — bypassing the remote
config fetch entirely. Used by the admin app
(`hotel-widget-admin`) to provide a WYSIWYG editing iframe over
`transparent.html`.

---

## License

MIT.
