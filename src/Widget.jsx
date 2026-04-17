import React, { useEffect, useMemo, useRef, useState } from 'react';
import MiniCalendar from './MiniCalendar.jsx';
import { resolveLocale, loadLocale, makeT, isRtl } from './i18n.js';
import {
  loadPriceData,
  aggregateStay,
  addDays,
  formatISO,
  differenceInNights,
} from './data.js';
import { derivePalette, isDarkTheme } from './colors.js';
import {
  initAnalytics,
  trackOpened,
  trackRoomChanged,
  trackDatesChanged,
  trackSavingsShown,
  trackReserveClicked,
} from './analytics.js';

/**
 * Main widget component.
 *
 * State machine:
 *   loading  -> CSV in flight
 *   error    -> fetch or parse failed (shown inline, non-intrusive)
 *   ready    -> data loaded, UI interactive
 *
 * The widget is two visual states: COLLAPSED (a compact pill showing the
 * direct price and savings) and EXPANDED (full comparison panel). This is
 * intentional — a sticky floating element that always shows a full comparison
 * would feel heavy on a marketing page. The pill invites interaction.
 */
export default function Widget({ config }) {
  const [data, setData] = useState(null);
  const [status, setStatus] = useState('loading');
  const [error, setError] = useState(null);

  // UI state
  const today = useMemo(() => startOfDay(new Date()), []);
  const [checkIn, setCheckIn] = useState(today);
  const [checkOut, setCheckOut] = useState(addDays(today, 1));
  const [roomId, setRoomId] = useState(config.default_room_id);
  const [expanded, setExpanded] = useState(false);
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [showAllOtas, setShowAllOtas] = useState(false);
  // Mobile-specific UI state
  const [isMobile, setIsMobile] = useState(false);
  const [scrolledDown, setScrolledDown] = useState(false);
  const { full: localeFull, primary: localePrimary } = useMemo(
    () => resolveLocale(config),
    [config.locale, config.enabledLocales, config.defaultLocale]
  );
  const [dict, setDict] = useState(null);
  const [rtl, setRtl] = useState(false);

  /* ----- Price aggregation (recomputes when inputs change) ------------- */
  const stay = useMemo(() => {
    if (!data) return null;
    return aggregateStay(data, roomId, checkIn, checkOut);
  }, [data, roomId, checkIn, checkOut]);

  const nights = differenceInNights(checkIn, checkOut);

  /* ----- Build the reserve URL ---------------------------------------- */
  const reserveHref = useMemo(() => {
    return config.reserveUrl
      .replace('{checkIn}', formatISO(checkIn))
      .replace('{checkOut}', formatISO(checkOut))
      .replace('{roomId}', encodeURIComponent(roomId));
  }, [config.reserveUrl, checkIn, checkOut, roomId]);

  /* ----- Formatters --------------------------------------------------- */
  const currencyFmt = useMemo(
    () =>
      new Intl.NumberFormat(localeFull, {
        style: 'currency',
        currency: config.currency,
        maximumFractionDigits: 2,
      }),
    [localeFull, config.currency]
  );

  const dateShortFmt = useMemo(
    () =>
      new Intl.DateTimeFormat(localeFull, {
        day: 'numeric',
        month: 'short',
      }),
    [localeFull]
  );

  /* ----- Ordered OTA list (cheapest → most expensive) ------------------ */
  const otaRows = useMemo(() => {
    if (!data || !stay) return [];
    return data.channels
      .map((ch) => ({
        key: ch,
        label: config.channelLabels?.[ch] || prettyChannelName(ch),
        total: stay.totals[ch],
      }))
      .sort((a, b) => {
        if (a.total === null) return 1;
        if (b.total === null) return -1;
        return a.total - b.total;
      });
  }, [data, stay, config.channelLabels]);

  /* ----- Top savings line (vs. cheapest OTA that has data) ------------- */
  const topComparison = useMemo(() => {
    if (!stay || !stay.hasDirect) return null;
    const cheapestOta = otaRows.find((r) => r.total !== null);
    if (!cheapestOta) return null;
    const savings = cheapestOta.total - stay.totals.direct;
    return { channel: cheapestOta.label, savings };
  }, [stay, otaRows]);

  /* ----- CSS custom properties for branding ---------------------------- */
  const brandStyle = useMemo(() => {
    return derivePalette({
      brandColor: config.brandColor,
      backgroundColor: config.backgroundColor,
    });
  }, [config.brandColor, config.backgroundColor]);

  const darkTheme = useMemo(
    () => isDarkTheme(config.backgroundColor),
    [config.backgroundColor]
  );

  /* --------------------------------------------------------------------- */
  /* Render                                                                */
  /* --------------------------------------------------------------------- */

  useEffect(() => {
    let cancelled = false;
    loadLocale(localePrimary).then((d) => {
      if (cancelled) return;
      setDict(d);
      setRtl(isRtl(localePrimary));
    });
    return () => { cancelled = true; };
  }, [localePrimary]);

  const t = useMemo(() => makeT(dict), [dict]);
  const calendarRef = useRef(null);
  const dateBtnRef = useRef(null);
  const rootRef = useRef(null);

  /* ----- Init analytics once ------------------------------------------- */
  useEffect(() => {
    initAnalytics(config);
  }, [config]);

  /* ----- Fire savings_shown when panel displays non-zero savings ------- */
  useEffect(() => {
    if (!expanded || !stay?.hasDirect || !topComparison || topComparison.savings <= 0) return;
    trackSavingsShown({
      roomId,
      nights,
      directPrice: stay.totals.direct,
      savings: topComparison.savings,
      vsChannel: topComparison.channel,
    });
  }, [expanded, roomId, nights, stay, topComparison]);

  /* ----- Fetch CSV once on mount --------------------------------------- */
  useEffect(() => {
    let cancelled = false;
    loadPriceData(config.csvUrl)
      .then((d) => {
        if (cancelled) return;
        setData(d);
        setStatus('ready');
      })
      .catch((err) => {
        if (cancelled) return;
        console.error('[hotel-price-widget]', err);
        setError(err.message || 'Could not load pricing data');
        setStatus('error');
      });
    return () => {
      cancelled = true;
    };
  }, [config.csvUrl]);

  /* ----- Close calendar on outside click ------------------------------- */
  /* ----- Close calendar on outside click ------------------------------- */
  useEffect(() => {
    if (!calendarOpen) return;
    function handleClick(e) {
      // CRITICAL: we live inside a Shadow DOM. When an event bubbles out of
      // the shadow into the host document, `e.target` is re-targeted to the
      // shadow host — NOT the actual clicked element. So `contains(e.target)`
      // always returns false for clicks inside the calendar, which would
      // close the calendar on every click INCLUDING clicks on dates.
      //
      // composedPath() gives us the real event path through the shadow
      // boundary. If the calendar element appears anywhere in that path,
      // the click was inside the calendar → keep it open.
      const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
      if (calendarRef.current && path.includes(calendarRef.current)) return;
      // Also ignore clicks on the date button itself (it toggles the calendar)
      if (dateBtnRef.current && path.includes(dateBtnRef.current)) return;
      setCalendarOpen(false);
    }
    document.addEventListener('mousedown', handleClick, true);
    return () => document.removeEventListener('mousedown', handleClick, true);
  }, [calendarOpen]);
  /* ----- Responsive detection ------------------------------------------ */
  useEffect(() => {
    // We don't rely on CSS alone because some layout decisions (like whether
    // to show the round icon or the full pill) are easier expressed in JS
    // than with 20 @media rules. Matches Tailwind's `sm` breakpoint.
    const mq = window.matchMedia('(max-width: 640px)');
    const update = () => setIsMobile(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);

  /* ----- Hide pill on scroll-down (mobile only) ----------------------- */
  useEffect(() => {
    if (!isMobile) return;
    // Don't hide when the panel is open — the pill is hidden anyway
    let lastY = window.scrollY;
    let ticking = false;
    function onScroll() {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        const y = window.scrollY;
        const delta = y - lastY;
        // Threshold prevents jittery flip-flopping on micro-scrolls
        if (Math.abs(delta) > 6) {
          setScrolledDown(delta > 0 && y > 80);
          lastY = y;
        }
        ticking = false;
      });
    }
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [isMobile]);


  const positionClass = `hpw-pos-${config.position || 'bottom-right'}`;

  return (
    <div
      ref={rootRef}
      dir={rtl ? 'rtl' : 'ltr'}
      className={[
        'hpw-container',
        positionClass,
        expanded && 'hpw-expanded',
        isMobile && 'hpw-mobile',
        isMobile && scrolledDown && !expanded && 'hpw-scrolled-away',
        darkTheme && 'hpw-dark',
      ].filter(Boolean).join(' ')}
      style={brandStyle}
    >
      {/* ============ COLLAPSED PILL / MOBILE ICON ============ */}
      {!expanded && (
        isMobile ? (
          <button
            type="button"
            className="hpw-fab"
            onClick={() => { setExpanded(true); trackOpened(); }}
            aria-label={t('compare_prices_aria')}
          >
            <span className="hpw-fab-icon" aria-hidden>€</span>
            {status === 'ready' && topComparison && topComparison.savings > 0 && (
              <span className="hpw-fab-badge" aria-hidden>↓</span>
            )}
          </button>
        ) : (
          <button
            type="button"
            className="hpw-pill"
            onClick={() => { setExpanded(true); trackOpened(); }}
            aria-label={t('open_price_comparison')}
          >
            <span className="hpw-pill-badge">
              <span className="hpw-dot" />
              <span>{t('best_price_guaranteed')}</span>
            </span>
            <span className="hpw-pill-body">
              {status === 'ready' && stay?.hasDirect ? (
                <>
                  <span className="hpw-pill-price">
                    {currencyFmt.format(stay.totals.direct)}
                  </span>
                  <span className="hpw-pill-sub">
                  {nights} {t('night_' + (nights === 1 ? 'one' : 'other'))} · {t('direct')}
                  </span>
                </>
              ) : status === 'loading' ? (
                <span className="hpw-pill-sub">{t('loading_rates')}</span>
              ) : status === 'error' ? (
                <span className="hpw-pill-sub">{t('compare_direct_prices')}</span>
              ) : (
                <span className="hpw-pill-sub">{t('select_dates')}</span>
              )}
            </span>
            <span className="hpw-pill-chev" aria-hidden>↗</span>
          </button>
        )
      )}

      {/* ============ EXPANDED PANEL ============ */}
      {expanded && (
        <div className="hpw-panel" role="dialog" aria-label="Price comparison">
          {/* Header */}
          <header className="hpw-header">
            <div className="hpw-brand">
              {config.logoUrl ? (
                <img src={config.logoUrl} alt={config.hotelName} className="hpw-logo" />
              ) : (
                <span className="hpw-brand-name">{config.hotelName}</span>
              )}
              <span className="hpw-eyebrow">{t('book_direct_best_rate')}</span>
            </div>
            <button
              type="button"
              ref={dateBtnRef}
              className="hpw-close"
              onClick={() => {
                setExpanded(false);
                setCalendarOpen(false);
              }}
              aria-label="Close"
            >
              ×
            </button>
          </header>

          {/* Controls */}
          <div className="hpw-controls">
            <button
              type="button"
              className="hpw-date-btn"
              onClick={() => setCalendarOpen((v) => !v)}
              aria-expanded={calendarOpen}
            >
              <span className="hpw-date-label">{t('your_stay')}</span>
              <span className="hpw-date-value">
                {dateShortFmt.format(checkIn)}
                <span className="hpw-date-arrow">→</span>
                {dateShortFmt.format(checkOut)}
              </span>
              <span className="hpw-date-nights">
              {t('night_' + (nights === 1 ? 'one' : 'other'))}
              </span>
            </button>

            <div className="hpw-room-wrap">
              <label className="hpw-room-label" htmlFor="hpw-room-select">
              {t('room')}
              </label>
              <select
                id="hpw-room-select"
                className="hpw-room-select"
                value={roomId}
                onChange={(e) => {
                  const newRoomId = e.target.value;
                  const newRoom = config.roomOptions.find(r => r.id === newRoomId);
                  setRoomId(newRoomId);
                  trackRoomChanged(newRoomId, newRoom?.name || '');
                }}
              >
                {config.roomOptions.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
              <span className="hpw-room-chev" aria-hidden>▾</span>
            </div>
          </div>

          {/* Calendar popover */}
          {calendarOpen && (
            <div ref={calendarRef} className="hpw-calendar-pop">
              <MiniCalendar
                selected={{ from: checkIn, to: checkOut }}
                minDate={today}
                locale={localeFull}
                onSelect={(range) => {
                  if (!range) return;
                  const { from, to } = range;
                  if (from && to && from.getTime() !== to.getTime()) {
                    setCheckIn(from);
                    setCheckOut(to);
                    setCalendarOpen(false);
                    trackDatesChanged(formatISO(from), formatISO(to), differenceInNights(from, to));
                  } else if (from) {
                    setCheckIn(from);
                    setCheckOut(addDays(from, 1));
                    trackDatesChanged(formatISO(from), formatISO(addDays(from, 1)), 1);
                  }
                }}
              />
            </div>
          )}

          {/* Headline price */}
          <div className="hpw-headline">
            {status === 'loading' && (
              <div className="hpw-skeleton hpw-skeleton-price" />
            )}
            {status === 'error' && (
              <div className="hpw-error">
                {t('couldnt_load_rates')} {error && <span>({error})</span>}
              </div>
            )}
            {status === 'ready' && !stay?.hasDirect && (
              <div className="hpw-unavailable">
                {t('room_unavailable')}
              </div>
            )}
            {status === 'ready' && stay?.hasDirect && (
              <>
                <div className="hpw-headline-eyebrow">{t('direct_on_our_site')}</div>
                <div className="hpw-headline-price">
                  {currencyFmt.format(stay.totals.direct)}
                </div>
                <div className="hpw-headline-sub">
                  {t('total_for_nights_' + (nights === 1 ? 'one' : 'other'), { n: nights })}
                </div>
                {topComparison && topComparison.savings > 0 && (
                  <div className="hpw-savings">{(() => {
                    const parts = t('you_save_vs', {
                      amount: '__AMOUNT__',
                      channel: topComparison.channel,
                    }).split('__AMOUNT__');
                    return (
                      <>
                        {parts[0]}
                        <strong>{currencyFmt.format(topComparison.savings)}</strong>
                        {parts[1]}
                      </>
                    );
                  })()}
                  </div>
                )}
                {topComparison && topComparison.savings <= 0 && (
                  <div className="hpw-savings hpw-savings-match">
                    {t('matching_ota')}
                  </div>
                )}
              </>
            )}
          </div>

          {/* OTA comparison list — hidden while the calendar is open to keep
              the panel compact. Shows top 3 by default; user can expand. */}
          {status === 'ready' && stay?.hasDirect && !calendarOpen && (
            <>
              <ul className="hpw-ota-list">
                {(showAllOtas ? otaRows : otaRows.slice(0, 3)).map((row) => {
                  const unavailable = row.total === null;
                  const diff = unavailable ? null : row.total - stay.totals.direct;
                  return (
                    <li key={row.key} className="hpw-ota-row">
                      <span className="hpw-ota-name">{row.label}</span>
                      <span className="hpw-ota-price">
                        {unavailable ? (
                          <span className="hpw-ota-na">{t('not_available')}</span>
                        ) : (
                          <>
                            <span className="hpw-ota-amount">
                              {currencyFmt.format(row.total)}
                            </span>
                            {diff > 0 && (
                              <span className="hpw-ota-delta">
                                +{currencyFmt.format(diff)}
                              </span>
                            )}
                            {diff === 0 && (
                              <span className="hpw-ota-delta hpw-ota-delta-flat">=</span>
                            )}
                          </>
                        )}
                      </span>
                    </li>
                  );
                })}
              </ul>
              {otaRows.length > 3 && (
                <button
                  type="button"
                  className="hpw-show-more"
                  onClick={() => setShowAllOtas((v) => !v)}
                >
                  {showAllOtas
                      ? t('show_fewer_channels')
                      : t('show_all_channels', { n: otaRows.length })}
                  <span className="hpw-show-more-chev" aria-hidden>
                    {showAllOtas ? '↑' : '↓'}
                  </span>
                </button>
              )}
            </>
          )}

          {/* CTA */}
          <a
            className="hpw-cta"
            href={reserveHref}
            target="_blank"
            rel="noopener noreferrer"
            aria-disabled={!stay?.hasDirect}
            onClick={() => trackReserveClicked({
              roomId,
              nights,
              directPrice: stay?.totals.direct || null,
              checkIn: formatISO(checkIn),
              checkOut: formatISO(checkOut),
            })}
          >
            <span>{t('reserve_direct')}</span>
            <span className="hpw-cta-arrow" aria-hidden>→</span>
          </a>

          <footer className="hpw-footer">
            <span>{t('prices_refreshed')}</span>
          </footer>
        </div>
      )}
    </div>
  );
}

/* ----- helpers --------------------------------------------------------- */

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function prettyChannelName(raw) {
  return raw
    .split(/[_\s]+/)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join('.');
}

// Pick black or white for the text that sits on the brand color.
// Uses WCAG relative luminance.
function readableInk(hex) {
  const clean = hex.replace('#', '');
  const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean;
  const r = parseInt(full.slice(0, 2), 16) / 255;
  const g = parseInt(full.slice(2, 4), 16) / 255;
  const b = parseInt(full.slice(4, 6), 16) / 255;
  const lum = [r, g, b].map((c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
  const L = 0.2126 * lum[0] + 0.7152 * lum[1] + 0.0722 * lum[2];
  return L > 0.5 ? '#111111' : '#ffffff';
}
