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

import { useState, useEffect, useMemo, useRef, useLayoutEffect, useId } from 'react';
import { createPortal } from 'react-dom';
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
import {
  initTracker,
  track as trackerSend,
  peekUid,
  exposeOnWindow as exposeTrackerOnWindow,
} from './tracker.js';
import { deriveWaxStops, deriveStampStops, mixHex } from './wax.js';
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

// ─── Book button portal ─────────────────────────────────────────────
// Renders the Book button anchor into document.body (light DOM), pinned
// over a shadow-DOM placeholder via getBoundingClientRect. Needed so the
// user's trusted click lands on an anchor that GTM's cross-domain linker
// can actually see — shadow DOM hides anchors from GTM's target-based
// lookup, even with composedPath available on the event.

const PORTAL_STYLE_ID = 'hpw-book-btn-portal-styles';

function ensurePortalStyles() {
  if (document.getElementById(PORTAL_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = PORTAL_STYLE_ID;
  style.textContent =
    '.hpw-book-btn-portal:hover{filter:brightness(1.08)}' +
    '.hpw-book-btn-portal:active{transform:translateY(1px)}';
  document.head.appendChild(style);
}

function BookButtonPortal({ placeholderEl, href, onClick, label, brandColor }) {
  const [rect, setRect] = useState(null);

  useLayoutEffect(() => {
    if (!placeholderEl) return;

    const update = () => setRect(placeholderEl.getBoundingClientRect());
    update();

    const ro = new ResizeObserver(update);
    ro.observe(placeholderEl);
    window.addEventListener('resize', update);

    return () => {
      ro.disconnect();
      window.removeEventListener('resize', update);
    };
  }, [placeholderEl]);

  useEffect(() => { ensurePortalStyles(); }, []);

  if (!rect || !href) return null;

  return createPortal(
    <a
      href={href}
      target="_blank"
      rel="noopener"
      onClick={onClick}
      className="hpw-book-btn-portal"
      style={{
        position: 'fixed',
        top: `${rect.top}px`,
        left: `${rect.left}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: brandColor,
        color: 'black',
        border: 0,
        borderRadius: '8px',
        fontSize: '13px',
        fontWeight: 500,
        fontFamily: 'inherit',
        letterSpacing: '0.06em',
        textTransform: 'uppercase',
        textDecoration: 'none',
        cursor: 'pointer',
        boxSizing: 'border-box',
        transition: 'filter 140ms, transform 120ms',
        zIndex: 2147483647,
      }}
    >
      {label}
    </a>,
    document.body
  );
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
  const [bookBtnPlaceholderEl, setBookBtnPlaceholderEl] = useState(null);

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

  // Wax-seal palette derived via OKLCH. Reads the optional toggleColor
  // override first, falls back to brandColor — so the operator can
  // pick a different hue for the closed-state seal without changing
  // the brand color used elsewhere in the widget.
  const wax = useMemo(
    () => deriveWaxStops(config.toggleColor || config.brandColor || '#1a1a1a'),
    [config.toggleColor, config.brandColor]
  );

  // Stable, unique id for the radial-gradient <defs> so two widgets on
  // the same page can't collide (e.g. preview + live).
  const sealGradId = useId().replace(/[:]/g, '_') + '-seal';

  // The closed-state label is a two-line eyebrow. Split the localized
  // string at its midpoint by word so "Best Price Guaranteed" →
  // "BEST PRICE" / "GUARANTEED" and "Meilleur Prix Garanti" →
  // "MEILLEUR PRIX" / "GARANTI" both look right.
  const eyebrowLines = useMemo(() => {
    const raw = String(i18n.t('bestPriceGuaranteed') || '').trim();
    const words = raw.split(/\s+/).filter(Boolean);
    if (words.length <= 1) return [raw, ''];
    const mid = Math.ceil(words.length / 2);
    return [words.slice(0, mid).join(' '), words.slice(mid).join(' ')];
  }, [i18n]);

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

  // Init first-party tracker + fire widget_loaded once. Skipped in
  // preview mode so admin previews don't pollute production stats.
  // Also exposes window.HPW.track so the host page (or a GTM tag on
  // the booking-flow confirmation page) can fire custom events with
  // booking metadata without owning the cookie/endpoint plumbing.
  useEffect(() => {
    if (config._preview) return;
    initTracker(config);
    exposeTrackerOnWindow();
    trackerSend('widget_loaded');
  }, [config]);

  // Cross-domain landing suppression: if hpw_uid is on the URL, the
  // visitor just came through this widget on another page (the Book
  // button decorated the URL). Reopening the widget on the booking
  // engine would feel like spam. Mark the session as dismissed so the
  // auto-open effect below bails. Runs regardless of consent state —
  // the sessionStorage flag is an opaque "1", no identifier.
  useEffect(() => {
    if (config._preview) return;
    if (typeof location === 'undefined') return;
    try {
      const p = new URLSearchParams(location.search);
      if (p.get('hpw_uid')) {
        markDismissedThisSession(config.hotelName);
      }
    } catch {
      // sessionStorage may be unavailable (private mode); ignore.
    }
  }, [config._preview, config.hotelName]);

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
    // Preview-only override from the admin's Appearance tab. When set,
    // it's the source of truth for the initial state — beats both
    // autoOpenMode and the dismiss flag.
    if (config._preview && config._previewState === 'closed') return;
    if (config._preview && config._previewState === 'open') {
      if (!expanded) setExpanded(true);
      return;
    }

    const mode = config.autoOpenMode;
    if (!mode || mode === 'disabled') return;
    if (expanded) return;
    if (!config._preview && isDismissedThisSession(config.hotelName)) return;

    // In preview without an explicit state override: open immediately
    // for instant feedback in the admin.
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
        trackerSend('widget_opened');
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
      config._preview, config._previewState, config.hotelName, expanded]);

  // ─── Handlers ─────────────────────────────────────────────────────

  function handleOpen() {
    if (expanded) return;
    setExpanded(true);
    trackOpened();
    trackerSend('widget_opened');
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
    trackerSend('book_clicked', {
      nights,
      checkIn,
      checkOut,
      directPrice: directChannel?.total || null,
      currency: rates?.currency || config.currency || 'EUR',
    });
  }

  // ─── Rendering helpers ────────────────────────────────────────────
  const currency = rates?.currency || config.currency || 'EUR';
  const status = rates?.status || 'loading';
  const showFallback = status === 'fallback' || !directChannel;

  // Rendered as the Book button's href so the user's trusted click can be
  // decorated by GTM's cross-domain linker (synthetic clicks are ignored).
  // When tracking is enabled and consent has been granted, also append
  // hpw_uid + hpw_hotel so the booking engine's confirmation page can
  // attribute the sale back to this widget visit.
  let reserveHref = (config.reserveUrl || '')
    .replace('{checkIn}', checkIn)
    .replace('{checkOut}', checkOut) || undefined;
  if (reserveHref) {
    const uid = peekUid();
    if (uid) {
      const hotelId = config._hotelId || config.hotelName || '';
      const sep = reserveHref.includes('?') ? '&' : '?';
      reserveHref +=
        `${sep}hpw_uid=${encodeURIComponent(uid)}` +
        `&hpw_hotel=${encodeURIComponent(hotelId)}`;
    }
  }

  return (
    <div
      ref={rootRef}
      dir={rtl ? 'rtl' : 'ltr'}
      className={[
        'hpw-container',
        `hpw-design-${config.widgetDesign || 'default'}`,
        positionClass,
        `hpw-size-${config.size || 'small'}`,
        expanded && 'hpw-expanded',
        isMobile && 'hpw-mobile',
        isMobile && scrolledDown && !expanded && 'hpw-scrolled-away',
        (darkTheme || config.widgetDesign === 'ticker') && 'hpw-dark',
      ].filter(Boolean).join(' ')}
      style={brandStyle}
    >
      {config.widgetDesign === 'ticker' && (
        <TickerVariant
          expanded={expanded}
          onToggle={() => (expanded ? handleClose() : handleOpen())}
          directPrice={
            directChannel && rates?.status === 'ok'
              ? Math.round(directChannel.total)
              : null
          }
          competitors={otaChannels.map((c) => ({
            name: getChannelName(c.id, rates),
            price: Math.round(c.total),
          }))}
          currency={currency}
          locale={locale}
          checkIn={checkIn}
          checkOut={checkOut}
          nights={nights}
          formatDate={formatDate}
          formatCurrency={formatCurrency}
          brandAccent={config.brandColor || '#C9A87A'}
          bookBtnPlaceholderRef={setBookBtnPlaceholderEl}
          onDatesChange={(newCheckIn, newCheckOut) => {
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
      )}

      {config.widgetDesign !== 'ticker' && !expanded && (
        <button
          type="button"
          className="hpw-toggle"
          onClick={handleOpen}
          aria-label={t('openWidget')}
        >
          <span className="hpw-toggle-seal" aria-hidden="true">
            <svg width="60" height="60" viewBox="0 0 60 60">
              <defs>
                <radialGradient id={sealGradId} cx="50%" cy="50%" r="50%">
                  <stop offset="0%" stopColor={wax.center} />
                  <stop offset="50%" stopColor={wax.mid} />
                  <stop offset="100%" stopColor={wax.edge} />
                </radialGradient>
              </defs>
              <circle
                cx="30"
                cy="30"
                r="28"
                fill={`url(#${sealGradId})`}
                stroke={wax.edge}
                strokeWidth="0.5"
              />
              <circle
                cx="30"
                cy="30"
                r="25"
                fill="none"
                stroke={wax.ringColor}
                strokeWidth="2"
              />
              <g transform="translate(30 30)">
                <path
                  d="M0 -12 L11 -8 V0 C11 7 0 13 0 13 C0 13 -11 7 -11 0 V-8 Z"
                  fill="none"
                  stroke={wax.markColor}
                  strokeWidth="1.3"
                  strokeLinejoin="round"
                  strokeLinecap="round"
                />
                <text
                  x="0"
                  y="0"
                  textAnchor="middle"
                  dominantBaseline="central"
                  fill={wax.markColor}
                  fontFamily="'Cormorant Garamond', 'EB Garamond', Garamond, 'Times New Roman', serif"
                  fontSize="16"
                  fontWeight="500"
                  letterSpacing="-0.02em"
                >
                  €
                </text>
              </g>
            </svg>
          </span>
          <span className="hpw-toggle-flag">
            <span className="hpw-toggle-eyebrow">
              <span>{eyebrowLines[0]}</span>
              {eyebrowLines[1] && <span>{eyebrowLines[1]}</span>}
            </span>
            {directChannel && rates?.status === 'ok' && (
              <>
                <span className="hpw-toggle-divider" aria-hidden="true" />
                <span className="hpw-toggle-price-row">
                  <span className="hpw-toggle-price">
                    {formatCurrency(directChannel.total, currency, locale)}
                  </span>
                  <svg
                    className="hpw-toggle-check"
                    width="12"
                    height="12"
                    viewBox="0 0 12 12"
                    aria-hidden="true"
                  >
                    <path
                      d="M2.5 6.2 L5 8.5 L9.5 3.5"
                      fill="none"
                      stroke={wax.edge}
                      strokeWidth="1.6"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </span>
              </>
            )}
          </span>
        </button>
      )}

      {config.widgetDesign !== 'ticker' && expanded && (
        <V5StampPanel
          config={config}
          t={t}
          locale={locale}
          checkIn={checkIn}
          checkOut={checkOut}
          nights={nights}
          rates={rates}
          loading={loading}
          showFallback={showFallback}
          directChannel={directChannel}
          otaChannels={otaChannels}
          getChannelName={getChannelName}
          formatDate={formatDate}
          formatCurrency={formatCurrency}
          currency={currency}
          onClose={handleClose}
          onDatesChange={(newCheckIn, newCheckOut) => {
            setCheckIn(newCheckIn);
            setCheckOut(newCheckOut);
            trackDatesChanged(
              newCheckIn,
              newCheckOut,
              daysBetween(newCheckIn, newCheckOut)
            );
          }}
          bookBtnPlaceholderRef={setBookBtnPlaceholderEl}
        />
      )}

      {/* Single Book button overlay anchor at the widget root. Whichever
          variant currently owns the ref (default panel placeholder OR
          ticker CTA) is the one this floating <a> follows. */}
      <BookButtonPortal
        placeholderEl={bookBtnPlaceholderEl}
        href={reserveHref}
        onClick={handleBook}
        label={`${t('bookNow')} →`}
        brandColor={config.brandColor || '#1a1a1a'}
      />
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
function StayPicker({ checkIn, checkOut, nights, locale, onChange, t, renderTrigger }) {
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

  // Default trigger keeps backwards-compat with any caller that
  // didn't pass a renderTrigger prop. V5 and ticker variants pass
  // their own design-specific triggers.
  const triggerNode = renderTrigger ? (
    renderTrigger({ onClick: handleToggle, open })
  ) : (
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
  );

  return (
    <div className="hpw-stay" ref={wrapRef}>
      {triggerNode}

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

// ─── Ticker variant — full widget (rail + expandable panel) ────────
// Bloomberg-terminal aesthetic. Closed = thin 36px black bottom rail
// with a marquee of competitor OTA prices (each shown as more
// expensive than direct, in red). Open = a 380px dark panel that
// expands UPWARD with a count-down hero price (animates from
// cheapest OTA → direct rate over 1200ms ease-out cubic), a savings
// line in green, an OTA comparison table, and a "LOCK THIS RATE" CTA.
//
// Reuses the parent widget's BookButtonPortal — the CTA placeholder
// element gets the bookBtnPlaceholderRef passed from Widget root.
function TickerVariant({
  expanded,
  onToggle,
  directPrice,
  competitors,
  currency,
  locale,
  checkIn,
  checkOut,
  nights,
  formatDate,
  formatCurrency,
  brandAccent,
  bookBtnPlaceholderRef,
  onDatesChange,
  t,
}) {
  // Cheapest competitor drives savings + count-down start. Falls back
  // to a placeholder spread if rates aren't loaded yet so the rail
  // stays populated rather than flashing empty.
  const items = competitors.length
    ? competitors
    : [
        { name: 'Booking.com', price: directPrice ? Math.round(directPrice * 1.18) : 0 },
        { name: 'Expedia',     price: directPrice ? Math.round(directPrice * 1.21) : 0 },
        { name: 'Hotels.com',  price: directPrice ? Math.round(directPrice * 1.16) : 0 },
        { name: 'Agoda',       price: directPrice ? Math.round(directPrice * 1.13) : 0 },
      ];

  const cheapest = items.reduce(
    (min, c) => (c.price && c.price < min ? c.price : min),
    Infinity
  );
  const hasCheapest =
    Number.isFinite(cheapest) && cheapest > 0 && directPrice > 0;
  const savings = hasCheapest ? cheapest - directPrice : 0;
  const savingsPct =
    hasCheapest && cheapest > 0
      ? Math.round((savings / cheapest) * 100)
      : 0;

  const marqueeDuration = Math.max(20, items.length * 4);
  const trackItems = items.concat(items).concat(items);

  // Count-down: cheapest → direct over 1200ms ease-out cubic when
  // opening; reset to cheapest when closing so the next open replays
  // fresh. Cancel any in-flight RAF on cleanup.
  const [displayed, setDisplayed] = useState(directPrice || 0);
  const rafRef = useRef(null);
  useEffect(() => {
    if (!hasCheapest) {
      setDisplayed(directPrice || 0);
      return;
    }
    if (!expanded) {
      setDisplayed(cheapest);
      return;
    }
    const start = performance.now();
    const from = cheapest;
    const to = directPrice;
    const duration = 1200;
    const tick = (now) => {
      const elapsed = (now - start) / duration;
      const tt = Math.min(elapsed, 1);
      const eased = 1 - Math.pow(1 - tt, 3);
      setDisplayed(Math.round(from + (to - from) * eased));
      if (tt < 1) rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [expanded, directPrice, cheapest, hasCheapest]);

  const settled = expanded && displayed === directPrice;
  const railLabel = expanded
    ? 'Close best-price panel'
    : hasCheapest && savings > 0
      ? 'Open best-price panel — direct rate beats ' +
        items.length + ' sites by ' +
        formatCurrency(savings, currency, locale)
      : (t && t('openWidget')) || 'Open best-price panel';

  return (
    <div className="hpw-tk-root">
      <div
        id="hpw-tk-panel"
        className={'hpw-tk-panel ' + (expanded ? 'is-open' : '')}
        aria-hidden={!expanded}
      >
        <div className="hpw-tk-panel-inner">
          <div className="hpw-tk-header">
            <StayPicker
              checkIn={checkIn}
              checkOut={checkOut}
              nights={nights}
              locale={locale}
              onChange={onDatesChange}
              t={t}
              renderTrigger={({ onClick, open }) => (
                <button
                  type="button"
                  className={'hpw-tk-kicker hpw-tk-kicker-btn ' + (open ? 'is-open' : '')}
                  onClick={onClick}
                  aria-expanded={open}
                  aria-label={(t && t('yourStay')) || 'Your stay'}
                >
                  LIVE RATE · {formatDate(checkIn, locale)}–{formatDate(checkOut, locale)}
                </button>
              )}
            />
            <span className="hpw-tk-livestamp" aria-hidden="true">
              <span className="hpw-tk-live-dot" />
              <span>LIVE</span>
            </span>
          </div>

          <div className="hpw-tk-hero">
            {directPrice
              ? formatCurrency(displayed, currency, locale)
              : '—'}
          </div>

          {hasCheapest && (
            <div
              className={'hpw-tk-savings ' + (settled ? 'is-settled' : '')}
            >
              ▼ −{formatCurrency(savings, currency, locale)} ({savingsPct}%) vs cheapest OTA
            </div>
          )}

          <div className="hpw-tk-table" role="table">
            <div className="hpw-tk-table-head" role="row">
              <span role="columnheader">Source</span>
              <span role="columnheader">Rate</span>
              <span role="columnheader">Δ</span>
            </div>
            {items.map((ota, i) => {
              const diff = directPrice ? ota.price - directPrice : 0;
              return (
                <div key={'ota-' + i} className="hpw-tk-table-row" role="row">
                  <span role="cell">{ota.name}</span>
                  <span role="cell" className="hpw-tk-cell-num">
                    {formatCurrency(ota.price, currency, locale)}
                  </span>
                  <span role="cell" className="hpw-tk-cell-up">
                    +{formatCurrency(diff, currency, locale)}
                  </span>
                </div>
              );
            })}
            <div className="hpw-tk-table-row hpw-tk-table-direct" role="row">
              <span role="cell">This site (direct)</span>
              <span role="cell" className="hpw-tk-cell-num">
                {directPrice ? formatCurrency(directPrice, currency, locale) : '—'}
              </span>
              <span role="cell" className="hpw-tk-cell-down">—</span>
            </div>
          </div>

          {/* CTA placeholder — BookButtonPortal at widget-root level
              overlays the real anchor here. */}
          <div
            ref={bookBtnPlaceholderRef}
            className="hpw-tk-cta"
            style={{ background: brandAccent, color: '#1A1410' }}
            aria-hidden="true"
          >
            Lock this rate →
          </div>

          <div className="hpw-tk-footer">Powered by d·edge</div>
        </div>
      </div>

      <button
        type="button"
        className="hpw-tk-rail"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-controls="hpw-tk-panel"
        aria-label={railLabel}
      >
        <span className="hpw-tk-fade-left" aria-hidden="true" />
        <span className="hpw-tk-fade-right" aria-hidden="true" />
        <span className="hpw-tk-live" aria-hidden="true">
          <span className="hpw-tk-live-dot" />
          <span>LIVE</span>
        </span>
        <span
          className="hpw-tk-hint"
          aria-hidden="true"
          style={{ color: brandAccent }}
        >
          {expanded ? '▾ COLLAPSE' : '▴ EXPAND'}
        </span>
        <div className="hpw-tk-stream" aria-hidden="true">
          <div
            className={'hpw-tk-track ' + (expanded ? 'is-paused' : '')}
            style={{ animationDuration: marqueeDuration + 's' }}
          >
            {trackItems.map((ota, i) => {
              const diff = directPrice ? ota.price - directPrice : 0;
              const last = i === trackItems.length - 1;
              return (
                <span key={i} className="hpw-tk-stream-item">
                  <span className="hpw-tk-stream-name">
                    {String(ota.name).toUpperCase()}
                  </span>
                  <span className="hpw-tk-stream-price">
                    {formatCurrency(ota.price, currency, locale)}
                  </span>
                  <span className="hpw-tk-stream-up">
                    +{formatCurrency(diff, currency, locale)}
                  </span>
                  {!last && <span className="hpw-tk-stream-sep">·</span>}
                </span>
              );
            })}
            {hasCheapest && directPrice && (
              <span
                className="hpw-tk-stream-item hpw-tk-stream-direct"
                style={{ color: brandAccent }}
              >
                <span className="hpw-tk-stream-direct-label">DIRECT</span>
                <span className="hpw-tk-stream-direct-price">
                  {formatCurrency(directPrice, currency, locale)}
                </span>
                <span className="hpw-tk-stream-down">
                  −{formatCurrency(savings, currency, locale)}
                </span>
                <span className="hpw-tk-stream-sep">·</span>
              </span>
            )}
          </div>
        </div>
      </button>
    </div>
  );
}

// ─── Default open panel — V5 Stamp ──────────────────────────────────
// Cream/linen panel with a wax-stamp savings medallion in the top-
// right. Editorial, opinionated. The stamp is the hero (it does the
// emotional work); the rest of the panel is calm and structural —
// no "+€diff" column on the OTA table, no green winner, just
// competitor prices with line-through to underline the savings.
//
// Surface colors are sourced from the existing config object with
// defaults: config.surface / config.surfaceInk / config.ctaBg /
// config.ctaInk. Stamp wax color comes from config.brandColor (or
// the optional toggleColor override) via deriveStampStops.
function V5StampPanel({
  config,
  t,
  locale,
  checkIn,
  checkOut,
  nights,
  rates,
  loading,
  showFallback,
  directChannel,
  otaChannels,
  getChannelName,
  formatDate,
  formatCurrency,
  currency,
  onClose,
  onDatesChange,
  bookBtnPlaceholderRef,
}) {
  // Surface palette from config with V5 defaults. Hotel brand wins;
  // when nothing is configured we land on the cream/ink V5 identity.
  const surface = config.surface || '#FAF4E8';
  const surfaceInk = config.surfaceInk || '#3A2818';
  const ctaBg = config.ctaBg || surfaceInk;
  const ctaInk = config.ctaInk || surface;

  // Derived support tones — kept perceptually relative to whatever
  // surface/ink the operator picked. mixHex is OKLCH-based so a navy
  // ink on cream surface still produces a recognizable "muted" mid.
  const muted = useMemo(() => mixHex(surfaceInk, surface, 0.45), [surfaceInk, surface]);
  const faint = useMemo(() => mixHex(surfaceInk, surface, 0.65), [surfaceInk, surface]);

  const stamp = useMemo(
    () => deriveStampStops(config.toggleColor || config.brandColor || '#7A2E1F'),
    [config.toggleColor, config.brandColor]
  );

  const cssVars = {
    '--v5-surface': surface,
    '--v5-ink': surfaceInk,
    '--v5-muted': muted,
    '--v5-faint': faint,
    '--v5-cta-bg': ctaBg,
    '--v5-cta-ink': ctaInk,
    '--v5-stamp-face': stamp.face,
    '--v5-stamp-edge': stamp.edge,
    '--v5-stamp-shadow': stamp.shadow,
    '--v5-stamp-ink': stamp.ink,
    '--v5-stamp-ringhi': stamp.ringHi,
    // Hairline borders and footer color are derived from ink + surface
    // so brand changes propagate consistently.
    '--v5-rule': mixHex(surfaceInk, surface, 0.82),
  };

  // Esc key closes regardless of focus location inside the panel.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const directPrice = directChannel?.total || null;
  const directLabel = directPrice ? formatCurrency(directPrice, currency, locale) : '—';
  const savings = rates?.savingsAmount > 0 ? rates.savingsAmount : 0;
  const savingsPct = rates?.savingsPercent > 0 ? rates.savingsPercent : 0;
  const savingsLabel = formatCurrency(savings, currency, locale);

  return (
    <div
      className="hpw-v5"
      style={cssVars}
      role="dialog"
      aria-modal="false"
      aria-labelledby="hpw-v5-price"
    >
      <button
        type="button"
        className="hpw-v5-close"
        onClick={onClose}
        aria-label={t('close')}
      >
        <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
          <path d="M3 3 L11 11 M11 3 L3 11" stroke="currentColor"
                strokeWidth="1.2" strokeLinecap="round" />
        </svg>
      </button>

      <StayPicker
        checkIn={checkIn}
        checkOut={checkOut}
        nights={nights}
        locale={locale}
        onChange={onDatesChange}
        t={t}
        renderTrigger={({ onClick, open }) => (
          <button
            type="button"
            className={'hpw-v5-dates ' + (open ? 'is-open' : '')}
            onClick={onClick}
            aria-expanded={open}
            aria-label={t('yourStay') || 'Your stay'}
          >
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
              <rect x="1.5" y="2.5" width="9" height="8" rx="1"
                    fill="none" stroke="currentColor" strokeWidth="1" />
              <path d="M1.5 5 L10.5 5 M4 1.5 L4 3 M8 1.5 L8 3"
                    stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
            </svg>
            <span className="hpw-v5-dates-range">
              {formatDate(checkIn, locale)} → {formatDate(checkOut, locale)}
            </span>
            <span className="hpw-v5-dates-sep">·</span>
            <span className="hpw-v5-dates-nights">
              {nights} {nights > 1 ? t('nights') : t('night')}
            </span>
          </button>
        )}
      />


      <div className="hpw-v5-hero">
        <div className="hpw-v5-kicker">{t('directRate') || 'Direct rate'}</div>
        <div id="hpw-v5-price" className="hpw-v5-price">
          {loading ? '…' : directLabel}
        </div>

        {savings > 0 && (
          <>
            <div className="hpw-v5-stamp" aria-hidden="true">
              <div className="hpw-v5-stamp-1">{t('youSave') || 'You save'}</div>
              <div className="hpw-v5-stamp-2">
                {savingsLabel}
              </div>
              <div className="hpw-v5-stamp-3">−{savingsPct}%</div>
            </div>
            <span className="hpw-v5-sr">
              You save {savingsLabel} — that's {savingsPct}% off the cheapest OTA rate.
            </span>
          </>
        )}
      </div>

      {!loading && !showFallback && otaChannels.length > 0 && (
        <div className="hpw-v5-otas">
          {otaChannels.map((ch) => {
            const priceLabel = formatCurrency(ch.total, currency, locale);
            const name = getChannelName(ch.id, rates);
            return (
              <div className="hpw-v5-ota-row" key={ch.id}>
                <span>{name}</span>
                <span
                  className="hpw-v5-ota-price"
                  aria-label={`${name}: was ${priceLabel}, struck through`}
                >
                  {priceLabel}
                </span>
              </div>
            );
          })}
        </div>
      )}

      <div className="hpw-v5-guarantee">
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          <path d="M6 1 L10.5 3 V6 C10.5 8.5 6 11 6 11 C6 11 1.5 8.5 1.5 6 V3 Z M4 6 L5.5 7.5 L8.5 4.5"
                fill="none" stroke="currentColor" strokeWidth="1"
                strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span>
          {t('bestPriceGuaranteed') || 'Best price guarantee'} · {t('noFees') || 'No fees'}
        </span>
      </div>

      {/* CTA placeholder — BookButtonPortal at widget-root overlays the
          real <a> on top of this. Color tokens applied here so the
          floating anchor inherits the look. */}
      <div
        ref={bookBtnPlaceholderRef}
        className="hpw-v5-cta"
        aria-hidden="true"
      >
        {t('bookNow') || 'Book direct'}
        <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
          <path d="M2.5 7 L11 7 M7 3 L11 7 L7 11"
                fill="none" stroke="currentColor" strokeWidth="1.4"
                strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>

      <div className="hpw-v5-footer">{t('poweredBy') || 'Powered by'} d·edge</div>
    </div>
  );
}
