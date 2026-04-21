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
import { DayPicker } from 'react-day-picker';
import 'react-day-picker/dist/style.css';

// ─── API channel metadata ───────────────────────────────────────────
// Mirrors the admin's constants.js. Hardcoded here because the widget
// bundle is static and channel IDs from AvailPro never change.
const CHANNEL_NAME_OVERRIDES = {
  17: 'Direct',
  10: 'Booking.com',
  9: 'Expedia',
  27:'Agoda'
};

const DIRECT_CHANNEL_ID = 17;

function getChannelName(channelId, rates) {
  return (
    CHANNEL_NAME_OVERRIDES[channelId] ||
    rates?.channelNames?.[channelId] ||
    `Channel ${channelId}`
  );
}

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
    // Ordre "day month" (16 Apr) préservé par l'Intl selon la locale,
    // mais on s'assure de la concision avec month: 'short'.
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
  const [otasExpanded, setOtasExpanded] = useState(false);
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
      trackSavingsShown({
        roomId: null,
        nights: rates.nights,
        directPrice: directChannel?.total || null,
        savings: rates.savingsAmount,
        vsChannel: rates.bestOtaChannelId
          ? getChannelName(rates.bestOtaChannelId, rates)
          : null,
      });
    }
  }, [expanded, rates?.savingsAmount]);

  // Close on outside click (desktop)
  useEffect(() => {
    if (!expanded || isMobile) return;

    const onClick = (e) => {
      const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
      // Walk the full event path and check if any ancestor is our root
      const clickedInside = path.some((el) => el === rootRef.current);
      if (!clickedInside) handleClose();
    };

    const timer = setTimeout(() => {
      document.addEventListener('mousedown', onClick);
    }, 0);

    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', onClick);
    };
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
          <span className="hpw-toggle-label">{t('bestPrice')}</span>
          {directChannel && rates?.status === 'ok' ? (
            <>
              <span className="hpw-toggle-price">
                {formatCurrency(directChannel.total, currency, locale)}
              </span>
              {rates.savingsAmount > 0 && (
                <span className="hpw-toggle-savings">
                  {t('youSave')} {formatCurrency(rates.savingsAmount, currency, locale)}
                </span>
              )}
            </>
          ) : (
            <span className="hpw-toggle-sub">
              {t('bestPriceGuaranteed')}
            </span>
          )}
        </button>
      )}

      {expanded && (
        <div className="hpw-panel">
          <button
            type="button"
            className="hpw-close"
            onClick={handleClose}
            aria-label={t('close')}
          >×</button>
          {/* Stay block — summary button + popover calendar */}
          <StayPicker
            checkIn={checkIn}
            checkOut={checkOut}
            nights={nights}
            locale={locale}
            onChange={(newCheckIn, newCheckOut) => {
              setCheckIn(newCheckIn);
              setCheckOut(newCheckOut);
              trackDatesChanged(
                newCheckIn,
                newCheckOut,
                daysBetween(newCheckIn, newCheckOut)
              );
            }}
            t={t}
          />
          {/* Body */}
          {loading ? (
            <div className="hpw-loading">{t('loading')}</div>
          ) : showFallback ? (
            <div className="hpw-fallback">
              <p className="hpw-fallback-title">{t('bestPriceGuaranteed')}</p>
              <p className="hpw-fallback-sub">{t('fallbackText')}</p>
            </div>
          ) : (
            <>
              {/* Our direct price */}
              <div className="hpw-our-price">
                <span className="hpw-our-price-label">
                  {t('priceOnOfficialWebsite')}
                </span>
                <div className="hpw-our-price-amount">
                  {formatCurrency(directChannel.total, currency, locale)}
                </div>
                <span className="hpw-our-price-sub">
                  {t('totalFor')} {nights} {nights > 1 ? t('nights') : t('night')}
                </span>

                {rates.savingsAmount != null && rates.savingsAmount > 0 && (
                  <div className="hpw-savings-badge">
                    {t('youSave')}{' '}
                    <strong>{formatCurrency(rates.savingsAmount, currency, locale)}</strong>
                    {' '}({rates.savingsPercent}%)
                    {rates.bestOtaChannelId && (
                      <>
                        {' '}{t('vs')}{' '}
                        {getChannelName(rates.bestOtaChannelId, rates)}
                      </>
                    )}
                  </div>
                )}
              </div>

              {/* OTAs comparison */}
              {otaChannels.length > 0 && (
                <div className="hpw-otas">
                  <ul className="hpw-otas-list">
                    {(otasExpanded ? otaChannels : otaChannels.slice(0, 2)).map((ch) => {
                      const delta = ch.total - directChannel.total;
                      return (
                        <li key={ch.id} className="hpw-ota-row">
                          <span className="hpw-ota-name">
                            {getChannelName(ch.id, rates)}
                          </span>
                          <span className="hpw-ota-right">
                            <span className="hpw-ota-price">
                              {formatCurrency(ch.total, currency, locale)}
                            </span>
                            {delta > 0 && (
                              <span className="hpw-ota-delta">
                                -{formatCurrency(delta, currency, locale)}
                              </span>
                            )}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                  {otaChannels.length > 2 && (
                    <button
                      type="button"
                      className="hpw-otas-toggle"
                      onClick={() => setOtasExpanded((v) => !v)}
                    >
                      {otasExpanded
                        ? t('hideChannels')
                        : t('showAllChannels', { count: otaChannels.length })}
                      <span className={`hpw-otas-arrow ${otasExpanded ? 'up' : ''}`}>▼</span>
                    </button>
                  )}
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
 * Stay picker: compact summary + inline calendar that always requires
 * exactly two clicks to complete a selection.
 *
 * State machine:
 *   - 'idle'      : calendar closed, current stay shown in summary
 *   - 'checkin'   : user opened the picker, waiting for check-in click
 *   - 'checkout'  : check-in just clicked, waiting for check-out click
 *
 * Clicking the summary button starts a new cycle in 'checkin' step.
 * Click before check-in is silently ignored in 'checkout' step.
 */
function StayPicker({ checkIn, checkOut, nights, locale, onChange, t }) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState('checkin');
  const [pendingCheckIn, setPendingCheckIn] = useState(null);
  const wrapRef = useRef(null);

  // Close popover on outside click
  useEffect(() => {
    if (!open) return;
    const onClick = (e) => {
      const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
      if (!path.some((el) => el === wrapRef.current)) {
        setOpen(false);
        setStep('checkin');
        setPendingCheckIn(null);
      }
    };
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', onClick);
    }, 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', onClick);
    };
  }, [open]);

  function handleToggle() {
    if (!open) {
      // Opening fresh — reset to checkin step
      setStep('checkin');
      setPendingCheckIn(null);
    }
    setOpen((v) => !v);
  }

  // react-day-picker 'single' mode emits one Date. We interpret it ourselves.
  function handleDayClick(day) {
    if (!day) return;
    const iso = toISODate(day);

    if (step === 'checkin') {
      // First click: store the check-in, move to checkout step
      setPendingCheckIn(iso);
      setStep('checkout');
      return;
    }

    // step === 'checkout'
    if (!pendingCheckIn) return; // defensive

    // Ignore clicks on/before the check-in
    if (iso <= pendingCheckIn) {
      // Option: shake or toast. For now silently ignore.
      return;
    }

    // Commit the range
    onChange(pendingCheckIn, iso);
    setStep('checkin');
    setPendingCheckIn(null);
    setOpen(false);
  }

  // What to show as selected in the calendar depends on the step.
  // In 'checkin' mode we show nothing selected (waiting for new input).
  // In 'checkout' mode we show just the pending check-in.
  let selected = undefined;
  let modifiers = {};

  if (step === 'checkout' && pendingCheckIn) {
    selected = parseISODate(pendingCheckIn);
    // Mark everything after check-in as eligible (for visual hint)
    modifiers = {
      checkinSelected: parseISODate(pendingCheckIn),
    };
  }

  // Disabled dates: past, AND in checkout step, dates <= pendingCheckIn
  const disabled = step === 'checkout' && pendingCheckIn
    ? [{ before: new Date() }, { before: parseISODate(pendingCheckIn) }, parseISODate(pendingCheckIn)]
    : { before: new Date() };

  return (
    <div className="hpw-stay" ref={wrapRef}>
      <button
        type="button"
        className="hpw-stay-summary"
        onClick={handleToggle}
      >
        <span className="hpw-stay-label">{t('yourStay')}</span>
        <span className="hpw-stay-value">
          {formatDate(checkIn, locale)}
          <span className="hpw-stay-arrow">→</span>
          {formatDate(checkOut, locale)}
        </span>
        <span className="hpw-stay-nights">
          {nights} {nights > 1 ? t('nights') : t('night')}
        </span>
      </button>

      {open && (
        <div className="hpw-datepicker-popover">
          <DayPicker
            mode="single"
            selected={selected}
            onDayClick={handleDayClick}
            disabled={disabled}
            modifiers={modifiers}
            modifiersClassNames={{
              checkinSelected: 'rdp-checkin-selected',
            }}
            numberOfMonths={1}
            showOutsideDays
            weekStartsOn={1}
          />
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