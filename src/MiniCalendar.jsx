import React, { useState, useMemo } from 'react';
import { addDays, formatISO } from './data.js';

/**
 * Minimal range-select calendar. ~100 lines, zero deps.
 *
 * Replaces react-day-picker to shave ~80kB off the bundle. Covers the only
 * things this widget actually needs:
 *   - Range selection (check-in → check-out)
 *   - Disable past dates
 *   - Previous / next month navigation
 *   - Locale-aware month and weekday labels via Intl
 *
 * Week starts Monday by default (European hotel context). Pass `weekStartsOn`
 * to change it.
 */
export default function MiniCalendar({
  selected,           // { from: Date, to: Date }
  onSelect,           // (range) => void
  minDate,            // disable dates before this
  locale = 'en-GB',
  weekStartsOn = 1,   // 0 Sun, 1 Mon
}) {
  // Month being viewed — seeds from the selected check-in
  const [viewMonth, setViewMonth] = useState(() => startOfMonth(selected?.from || new Date()));
  // Tracks partial selection: when user clicks a start date, we wait for the
  // second click before firing onSelect.
  const [pending, setPending] = useState(null);

  const monthLabelFmt = useMemo(
    () => new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' }),
    [locale]
  );
  const weekdayFmt = useMemo(
    () => new Intl.DateTimeFormat(locale, { weekday: 'narrow' }),
    [locale]
  );

  // Header weekday labels, starting from weekStartsOn
  const weekdays = useMemo(() => {
    // Use any known Sunday as reference: 2024-01-07 is a Sunday
    const ref = new Date(2024, 0, 7);
    const labels = [];
    for (let i = 0; i < 7; i++) {
      const d = addDays(ref, (i + weekStartsOn) % 7);
      labels.push(weekdayFmt.format(d));
    }
    return labels;
  }, [weekdayFmt, weekStartsOn]);

  // Build the 6×7 grid for the current month
  const weeks = useMemo(() => buildMonthGrid(viewMonth, weekStartsOn), [viewMonth, weekStartsOn]);

  const today = startOfDay(new Date());
  const min = minDate ? startOfDay(minDate) : null;

  // Active range (either the committed selection or the pending partial one)
  const activeFrom = pending?.from || selected?.from || null;
  const activeTo   = pending?.to   || (pending ? null : selected?.to || null);

  function handleDayClick(day) {
    if (min && day < min) return;

    if (!pending || pending.to) {
      // Starting a new range
      setPending({ from: day, to: null });
    } else {
      // Completing the range
      const from = pending.from;
      let to = day;
      // If user clicked before the start, flip them
      if (to < from) {
        onSelect({ from: to, to: from });
      } else if (to.getTime() === from.getTime()) {
        // Same day — treat as 1-night stay ending next day
        onSelect({ from, to: addDays(from, 1) });
      } else {
        onSelect({ from, to });
      }
      setPending(null);
    }
  }

  function shift(delta) {
    const d = new Date(viewMonth);
    d.setMonth(d.getMonth() + delta);
    setViewMonth(d);
  }

  return (
    <div className="hpw-cal">
      <div className="hpw-cal-head">
        <button
          type="button"
          className="hpw-cal-nav"
          onClick={() => shift(-1)}
          aria-label="Previous month"
        >‹</button>
        <span className="hpw-cal-title">{monthLabelFmt.format(viewMonth)}</span>
        <button
          type="button"
          className="hpw-cal-nav"
          onClick={() => shift(1)}
          aria-label="Next month"
        >›</button>
      </div>

      <div className="hpw-cal-weekdays">
        {weekdays.map((w, i) => (
          <span key={i} className="hpw-cal-weekday">{w}</span>
        ))}
      </div>

      <div className="hpw-cal-grid">
        {weeks.flat().map((day, i) => {
          const inMonth = day.getMonth() === viewMonth.getMonth();
          const disabled = min && day < min;
          const isToday = sameDay(day, today);
          const isStart = activeFrom && sameDay(day, activeFrom);
          const isEnd   = activeTo   && sameDay(day, activeTo);
          const inRange = activeFrom && activeTo &&
                          day > activeFrom && day < activeTo;

          const classes = ['hpw-cal-day'];
          if (!inMonth)  classes.push('hpw-cal-day-out');
          if (disabled)  classes.push('hpw-cal-day-disabled');
          if (isToday)   classes.push('hpw-cal-day-today');
          if (isStart)   classes.push('hpw-cal-day-start');
          if (isEnd)     classes.push('hpw-cal-day-end');
          if (inRange)   classes.push('hpw-cal-day-in-range');

          return (
            <button
              key={i}
              type="button"
              disabled={disabled}
              className={classes.join(' ')}
              onClick={() => handleDayClick(day)}
              aria-label={formatISO(day)}
            >
              {day.getDate()}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ----- helpers ----- */

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function startOfMonth(d) {
  const x = new Date(d);
  x.setDate(1);
  x.setHours(0, 0, 0, 0);
  return x;
}

function sameDay(a, b) {
  return a && b &&
    a.getFullYear() === b.getFullYear() &&
    a.getMonth()    === b.getMonth() &&
    a.getDate()     === b.getDate();
}

// Returns 6 rows × 7 days covering the visible month
function buildMonthGrid(monthDate, weekStartsOn) {
  const first = startOfMonth(monthDate);
  // How many days to back up to reach weekStartsOn
  const offset = (first.getDay() - weekStartsOn + 7) % 7;
  const gridStart = addDays(first, -offset);

  const weeks = [];
  for (let w = 0; w < 6; w++) {
    const row = [];
    for (let d = 0; d < 7; d++) {
      row.push(addDays(gridStart, w * 7 + d));
    }
    weeks.push(row);
  }
  return weeks;
}
