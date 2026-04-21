/**
 * The main widget component. Renders the floating button + expandable panel.
 *
 * Flow:
 *   1. Mount: read config (from remote JSON or preview URL param)
 *   2. Initialize stay (today → tomorrow, 1 night)
 *   3. Fetch rates from the API proxy whenever dates or config change
 *   4. Render direct price prominently + OTAs comparison + Book button
 *
 * Preview mode: when config._preview is true, skip the real API call and
 * use buildPreviewData to show deterministic demo prices. The admin's
 * iframe uses this to offer real-time WYSIWYG editing.
 *
 * Fallback: if the API fails or no complete pricing is available, we show
 * "Best rate guaranteed" with the Book button. Better than showing stale
 * or partial data.
 */

import { useState, useEffect, useMemo, useRef } from 'react';
import { loadRatesFromApi, buildPreviewData } from './data.js';
import { resolveLocale, loadLocale, makeT, isRtl } from './i18n.js';
import {
  initAnalytics,
  trackOpened,
  trackDatesChanged,
  trackSavingsShown,
  trackReserveClicked,
  isDismissedThisSession,
  markDismissedThisSession,
} from './analytics.js';

// ─── API channel metadata ───────────────────────────────────────────
// Mirrors the admin's constants.js. Hardcoded here because the widget
// bundle is static and channel IDs from AvailPro never change.
const CHANNEL_META = {
  17: { name: 'Direct', isDirect: true },
  10: { name: 'Booking.com', isDirect: false },
  9:  { name: 'Expedia', isDirect: false },
};

const DIRECT_CHANNEL_ID = 17;

// ─── Date helpers ───────────────────────────────────────────────────

function todayISO() {
  const d = new Date();
  return toISODate(d);
}

function tomorrowISO() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return toISODate(d);
}

function toISODate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function parseISODate(s) {
  // Treat YYYY-MM-DD as UTC midnight to avoid timezone drift
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function addDays(isoStr, n) {
  const d = parseISODate(isoStr);
  d.setUTCDate(d.getUTCDate() + n);
  return toISODate(d);
}

function daysBetween(fromIso, toIso) {
  const from = parseISODate(fromIso);
  const to = parseISODate(toIso);
  return Math.round((to - from) / (1000 * 60 * 60 * 24));
}

function formatCurrency(amount, currency, locale) {
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      maximumFractionDigits: 0,
    }).format(amount);
  } catch {
    return `${currency} ${Math.round(amount)}`;
  }
}

function formatDate(isoStr, locale) {
  try {
    return new Intl.DateTimeFormat(locale, {
      day: 'numeric',
      month: 'short',
    }).format(parseISODate(isoStr));
  } catch {
    return isoStr;
  }
}

// ─── Main component ─────────────────────────────────────────────────

export default function Widget({ config }) {
  const [expanded, setExpanded] = useState(false);
  const [checkIn, setCheckIn] = useState(todayISO());
  const [checkOut, setCheckOut] = useState(tomorrowISO());
  const [rates, setRates] = useState(null);       // loaded rates summary
  const [loading, setLoading] = useState(true);
  const [isMobile, setIsMobile] = useState(false);
  const [scrolledDown, setScrolledDown] = useState(false);
  const [i18n, setI18n] = useState({ t: (k) => k, primary: 'en' });

  const rootRef = useRef(null);

  // ─── Derived values ────────────────────────────────────────────────
  const t = i18n.t;
  const locale = i18n.primary;
  const nights = useMemo(
    () => Math.max(1, daysBetween(checkIn, checkOut)),
    [checkIn, checkOut]
  );
  const rtl = isRtl(locale);
  const darkTheme = isColorDark(config.backgroundColor);
  const positionClass = `hpw-pos-${config.position || 'bottom-right'}`;

  const brandStyle = useMemo(
    () => ({
      '--hpw-brand': config.brandColor || '#1a1a1a',
      '--hpw-bg': config.backgroundColor || '#faf7f2',
    }),
    [config.brandColor, config.backgroundColor]
  );

  // Figure out which channels to display, and which rows in the OTAs list
  const directChannel = rates?.channels?.[DIRECT_CHANNEL_ID] || null;
  const otaChannels = useMemo(() => {
    if (!rates?.channels) return [];
    return Object.values(rates.channels)
      .filter((c) => c.id !== DIRECT_CHANNEL_ID)
      .sort((a, b) => a.total - b.total);
  }, [rates]);

  // ─── Effects ───────────────────────────────────────────────────────

  useEffect(() => {
    let cancelled = false;
    const { primary } = resolveLocale(config);
    loadLocale(primary).then((dict) => {
      if (!cancelled) {
        setI18n({ t: makeT(dict), primary });
      }
    });
    return () => { cancelled = true; };
  }, [config.locale, config.defaultLocale, config.enabledLocales?.join(',')]);
  // Init analytics once
  useEffect(() => {
    initAnalytics({config, _hotelId: config._hotelId || config.hotelName });
  }, [config]);

  // Load rates whenever dates or core config changes
  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    const stay = {
      checkIn: parseISODate(checkIn),
      checkOut: parseISODate(checkOut),
    };

    const loader = config._preview
      ? Promise.resolve(buildPreviewData(config))
      : loadRatesFromApi(config, stay);

    loader.then((result) => {
      if (!cancelled) {
        setRates(result);
        setLoading(false);
      }
    }).catch((err) => {
      if (!cancelled) {
        console.warn('[hpw] rates load failed', err);
        setRates({ status: 'fallback', channels: {} });
        setLoading(false);
      }
    });

    return () => { cancelled = true; };
  }, [checkIn, checkOut, config.apiHotelId, config.apiCompetitorId,
      config._preview, config.channelsEnabled?.join(',')]);

  // Savings shown event (once per open+load combo)
  useEffect(() => {
    if (expanded && rates?.status === 'ok' && rates.savingsAmount != null) {
      const directChannel = rates.channels?.[DIRECT_CHANNEL_ID];
      const bestOtaMeta = CHANNEL_META[rates.bestOtaChannelId];
      trackSavingsShown({
        roomId: null,                          // no room selector anymore
        nights: rates.nights,
        directPrice: directChannel?.total || null,
        savings: rates.savingsAmount,
        vsChannel: bestOtaMeta?.name || `channel_${rates.bestOtaChannelId}`,
      });
    }
  }, [expanded, rates?.savingsAmount]);

  // Close on outside click (desktop)
  useEffect(() => {
    if (!expanded || isMobile) return;
    const onClick = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) {
        handleClose();
      }
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [expanded, isMobile]);

  // Mobile detection
  useEffect(() => {
    const update = () => setIsMobile(window.innerWidth < 640);
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

  // Scroll-hide on mobile
  useEffect(() => {
    if (!isMobile) return;
    let lastY = window.scrollY;
    const onScroll = () => {
      const y = window.scrollY;
      setScrolledDown(y > lastY && y > 100);
      lastY = y;
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [isMobile]);

  // Auto-open triggers
  useEffect(() => {
    const mode = config.autoOpenMode;
    if (!mode || mode === 'disabled') return;
    if (expanded) return;
    if (!config._preview && isDismissedThisSession(config.hotelName)) return;

    // In preview: open immediately (instant feedback in admin)
    if (config._preview) {
      setExpanded(true);
      return;
    }

    let timer = null;
    let scrollHandler = null;
    const trigger = () => {
      if (!expanded) {
        setExpanded(true);
        trackOpened();  // Same event as manual open; mode implicit from context
      }
    };

    if (mode === 'time' || mode === 'time_or_scroll') {
      timer = setTimeout(trigger, (config.autoOpenDelay || 8) * 1000);
    }
    if (mode === 'scroll' || mode === 'time_or_scroll') {
      const threshold = (config.autoOpenScrollPercent || 50) / 100;
      let rafPending = false;
      scrollHandler = () => {
        if (rafPending) return;
        rafPending = true;
        requestAnimationFrame(() => {
          rafPending = false;
          const scrollable = document.documentElement.scrollHeight - window.innerHeight;
          if (scrollable <= 0) return;
          const ratio = window.scrollY / scrollable;
          if (ratio >= threshold) {
            trigger();
            if (scrollHandler) window.removeEventListener('scroll', scrollHandler);
          }
        });
      };
      window.addEventListener('scroll', scrollHandler, { passive: true });
    }

    return () => {
      if (timer) clearTimeout(timer);
      if (scrollHandler) window.removeEventListener('scroll', scrollHandler);
    };
  }, [config.autoOpenMode, config.autoOpenDelay, config.autoOpenScrollPercent,
      config._preview, config.hotelName, expanded]);

  // ─── Handlers ─────────────────────────────────────────────────────

  function handleOpen() {
    if (expanded) return;
    setExpanded(true);
    trackOpened();
  }

  function handleClose() {
    setExpanded(false);
    if (!config._preview) {
      markDismissedThisSession(config.hotelName);
    }
  }

  function handleCheckInChange(e) {
    const newCheckIn = e.target.value;
    let newCheckOut = checkOut;
    if (daysBetween(newCheckIn, checkOut) < 1) {
      newCheckOut = addDays(newCheckIn, 1);
    } else if (daysBetween(newCheckIn, checkOut) > 30) {
      newCheckOut = addDays(newCheckIn, 30);
    }
    setCheckIn(newCheckIn);
    setCheckOut(newCheckOut);
    trackDatesChanged(newCheckIn, newCheckOut, daysBetween(newCheckIn, newCheckOut));
  }

  function handleCheckOutChange(e) {
    const newCheckOut = e.target.value;
    if (daysBetween(checkIn, newCheckOut) < 1) return;
    if (daysBetween(checkIn, newCheckOut) > 30) return;
    setCheckOut(newCheckOut);
    trackDatesChanged(checkIn, newCheckOut, daysBetween(checkIn, newCheckOut));
  }

  function handleBook() {
    trackReserveClicked({
      roomId: null,
      nights,
      directPrice: directChannel?.total || null,
      checkIn,
      checkOut,
    });

    const url = (config.reserveUrl || '')
      .replace('{checkIn}', checkIn)
      .replace('{checkOut}', checkOut);
    if (url) window.open(url, '_blank', 'noopener');
  }

  // ─── Rendering helpers ────────────────────────────────────────────
  const currency = rates?.currency || config.currency || 'EUR';
  const status = rates?.status || 'loading';
  const showFallback = status === 'fallback' || !directChannel;

  return (
    <div
      ref={rootRef}
      dir={rtl ? 'rtl' : 'ltr'}
      className={[
        'hpw-container',
        positionClass,
        `hpw-size-${config.size || 'small'}`,
        expanded && 'hpw-expanded',
        isMobile && 'hpw-mobile',
        isMobile && scrolledDown && !expanded && 'hpw-scrolled-away',
        darkTheme && 'hpw-dark',
      ].filter(Boolean).join(' ')}
      style={brandStyle}
    >
      {!expanded && (
        <button
          type="button"
          className="hpw-toggle"
          onClick={handleOpen}
          aria-label={t('openWidget')}
        >
          {config.logoUrl ? (
            <img src={config.logoUrl} alt={config.hotelName} className="hpw-toggle-logo" />
          ) : (
            <span className="hpw-toggle-text">
              {t('bestPrice')}
            </span>
          )}
        </button>
      )}

      {expanded && (
        <div className="hpw-panel">
          {/* Header */}
          <header className="hpw-header">
            <div className="hpw-header-brand">
              {config.logoUrl && (
                <img src={config.logoUrl} alt="" className="hpw-header-logo" />
              )}
              <div>
                <h3 className="hpw-header-title">{config.hotelName}</h3>
                <p className="hpw-header-subtitle">
                  {t('bestRateGuaranteed')}
                </p>
              </div>
            </div>
            <button
              type="button"
              className="hpw-close"
              onClick={handleClose}
              aria-label={t('close')}
            >×</button>
          </header>

          {/* Dates */}
          <div className="hpw-dates">
            <label className="hpw-date-field">
              <span>{t('checkIn')}</span>
              <input
                type="date"
                value={checkIn}
                min={todayISO()}
                onChange={handleCheckInChange}
              />
            </label>
            <label className="hpw-date-field">
              <span>{t('checkOut')}</span>
              <input
                type="date"
                value={checkOut}
                min={addDays(checkIn, 1)}
                max={addDays(checkIn, 30)}
                onChange={handleCheckOutChange}
              />
            </label>
          </div>

          {/* Body */}
          {loading ? (
            <div className="hpw-loading">
              {t('loading')}
            </div>
          ) : showFallback ? (
            <div className="hpw-fallback">
              <p className="hpw-fallback-title">
                {t('bestPriceGuaranteed')}
              </p>
              <p className="hpw-fallback-sub">
                {t('fallbackText')}
              </p>
            </div>
          ) : (
            <>
              {/* Our direct price */}
              <div className="hpw-our-price">
                <span className="hpw-our-price-label">
                  {t('ourPrice')}
                </span>
                <div className="hpw-our-price-amount">
                  {formatCurrency(directChannel.total, currency, locale)}
                </div>
                <span className="hpw-our-price-sub">
                  {nights} {nights > 1 ? (t('nights')) : (t('night'))}
                  {' · '}
                  {formatCurrency(directChannel.avgPerNight, currency, locale)} / {t('night')}
                </span>

                {rates.savingsAmount != null && rates.savingsAmount > 0 && (
                  <div className="hpw-savings-badge">
                    {t('youSave')}{' '}
                    <strong>{formatCurrency(rates.savingsAmount, currency, locale)}</strong>
                    {' '}({rates.savingsPercent}%)
                  </div>
                )}
              </div>

              {/* OTAs comparison */}
              {otaChannels.length > 0 && (
                <div className="hpw-otas">
                  <div className="hpw-otas-label">
                    {t('compareWith')}
                  </div>
                  <ul className="hpw-otas-list">
                    {otaChannels.map((ch) => (
                      <li key={ch.id} className="hpw-ota-row">
                        <span className="hpw-ota-name">
                          {CHANNEL_META[ch.id]?.name || `Channel ${ch.id}`}
                        </span>
                        <span className="hpw-ota-price">
                          {formatCurrency(ch.total, currency, locale)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}

          {/* Book button */}
          <button
            type="button"
            className="hpw-book-btn"
            onClick={handleBook}
          >
            {t('bookNow')} →
          </button>

          {/* Footer */}
          <footer className="hpw-footer">
            {t('poweredBy')}
          </footer>
        </div>
      )}
    </div>
  );
}

/**
 * Returns true if a CSS color string is "dark" (for contrast decisions).
 * Simple luminance check: handles hex (#rrggbb or #rgb). Other formats
 * fall through as "light".
 */
function isColorDark(cssColor) {
  if (!cssColor || typeof cssColor !== 'string') return false;
  const hex = cssColor.trim().replace('#', '');
  let r, g, b;
  if (hex.length === 3) {
    r = parseInt(hex[0] + hex[0], 16);
    g = parseInt(hex[1] + hex[1], 16);
    b = parseInt(hex[2] + hex[2], 16);
  } else if (hex.length === 6) {
    r = parseInt(hex.slice(0, 2), 16);
    g = parseInt(hex.slice(2, 4), 16);
    b = parseInt(hex.slice(4, 6), 16);
  } else {
    return false;
  }
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance < 0.5;
}